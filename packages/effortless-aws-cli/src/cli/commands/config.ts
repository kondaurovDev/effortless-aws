import { Args, Command } from "@effect/cli";
import { Prompt } from "@effect/cli";
import { Effect, Console } from "effect";

import { Aws } from "../../aws";
import { ssm } from "~/aws/clients";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { collectRequiredSecrets, checkMissingSecrets } from "~/deploy/resolve-config";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { c } from "~/cli/colors";
import { toAwsTagList } from "~/aws/tags";

// ============ Shared helpers ============

const ssmTags = (project: string, stage: string, handlerName: string) =>
  toAwsTagList({
    "effortless:project": project,
    "effortless:stage": stage,
    "effortless:handler": handlerName,
  });

const loadRequiredParams = Effect.gen(function* () {
  const { project, stage, region, patterns, projectDir } = yield* CliContext;

  if (!patterns) {
    return yield* Effect.fail(new Error("No 'handlers' patterns in config"));
  }

  const files = findHandlerFiles(patterns, projectDir);
  const handlers = yield* discoverHandlers(files, projectDir);
  const params = collectRequiredSecrets(handlers, project, stage);
  return { params, project, stage, region };
});

// ============ Config data (pure — no side effects) ============

export type ConfigParam = {
  ssmPath: string;
  ssmKey: string;
  handlerName: string;
  status: "set" | "missing";
};

export type ConfigListResult = {
  project: string;
  stage: string;
  region: string;
  params: ConfigParam[];
  summary: { set: number; missing: number };
};

/** List all config parameters and their status. No Console output. */
export const getConfigList = Effect.gen(function* () {
  const ctx = yield* loadRequiredParams;
  const { params } = ctx;

  if (params.length === 0) {
    return {
      project: ctx.project, stage: ctx.stage, region: ctx.region,
      params: [] as ConfigParam[],
      summary: { set: 0, missing: 0 },
    } satisfies ConfigListResult;
  }

  const { existing, missing } = yield* checkMissingSecrets(params).pipe(
    Effect.provide(Aws.makeClients({ ssm: { region: ctx.region } }))
  );

  const all: ConfigParam[] = [
    ...existing.map(p => ({ ssmPath: p.ssmPath, ssmKey: p.ssmKey, handlerName: p.handlerName, status: "set" as const })),
    ...missing.map(p => ({ ssmPath: p.ssmPath, ssmKey: p.ssmKey, handlerName: p.handlerName, status: "missing" as const })),
  ].sort((a, b) => a.handlerName.localeCompare(b.handlerName) || a.ssmKey.localeCompare(b.ssmKey));

  return {
    project: ctx.project, stage: ctx.stage, region: ctx.region,
    params: all,
    summary: { set: existing.length, missing: missing.length },
  } satisfies ConfigListResult;
});

/** Set a config parameter value. No Console output. */
export const setConfig = (key: string, value: string) =>
  Effect.gen(function* () {
    const ctx = yield* loadRequiredParams;
    const { params } = ctx;

    const match = params.find(p => p.ssmKey === key);
    if (!match) {
      const available = [...new Set(params.map(p => p.ssmKey))].sort();
      return { error: `"${key}" is not declared in any handler`, available };
    }

    const ssmLayer = Aws.makeClients({ ssm: { region: ctx.region } });

    yield* ssm.make("put_parameter", {
      Name: match.ssmPath,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    }).pipe(Effect.provide(ssmLayer));

    yield* ssm.make("add_tags_to_resource", {
      ResourceType: "Parameter",
      ResourceId: match.ssmPath,
      Tags: ssmTags(ctx.project, ctx.stage, match.handlerName),
    }).pipe(Effect.provide(ssmLayer));

    return { set: match.ssmPath, handler: match.handlerName };
  });

// ============ CLI commands ============

const listCommand = Command.make(
  "list",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) =>
    Effect.gen(function* () {
      const result = yield* getConfigList;

      if (result.params.length === 0) {
        yield* Console.log("No config parameters declared in handlers.");
        return;
      }

      yield* Console.log(`\n${c.bold("Config parameters")} ${c.dim(`(${result.project} / ${result.stage})`)}\n`);

      for (const p of result.params) {
        const icon = p.status === "set" ? c.green("✓") : c.red("✗");
        const label = p.status === "set" ? c.dim("set") : c.red("missing");
        yield* Console.log(`  ${icon} ${c.dim(p.handlerName)}  ${p.ssmPath}  ${label}`);
      }

      if (result.summary.missing > 0) {
        yield* Console.log(`\n  ${c.yellow(`${result.summary.missing} missing`)} — run ${c.cyan("npx eff config")} to set them`);
      } else {
        yield* Console.log(`\n  ${c.green("All parameters are set.")}`);
      }
      yield* Console.log("");
    }).pipe(withCliContext(opts))
).pipe(Command.withDescription("List all declared config parameters and show which are set vs missing"));

// ============ eff config set <key> ============

const setKeyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription("SSM parameter key (e.g. stripe/secret-key)")
);

const setCommand = Command.make(
  "set",
  { key: setKeyArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ key, ...opts }) =>
    Effect.gen(function* () {
      const value = yield* Prompt.text({
        message: `Value for ${c.cyan(key)}`,
      });

      const result = yield* setConfig(key, value);

      if ("error" in result) {
        yield* Console.error(`Error: ${result.error}`);
        if (result.available && result.available.length > 0) {
          yield* Console.error(`\nAvailable keys:\n${result.available.map(k => `  - ${k}`).join("\n")}`);
        }
        return yield* Effect.fail(new Error(result.error));
      }

      yield* Console.log(`\n  ${c.green("✓")} ${c.cyan(result.set)} ${c.dim("(SecureString)")}`);
    }).pipe(withCliContext(opts))
).pipe(Command.withDescription("Set a config parameter value (stored encrypted in AWS)"));

// ============ eff config (default — interactive setup) ============

const configRootCommand = Command.make(
  "config",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) =>
    Effect.gen(function* () {
      const result = yield* getConfigList;

      if (result.params.length === 0) {
        yield* Console.log("No config parameters declared in handlers.");
        return;
      }

      const missing = result.params.filter(p => p.status === "missing");

      if (missing.length === 0) {
        yield* Console.log(`\n  ${c.green("All parameters are set.")} Nothing to do.\n`);
        return;
      }

      yield* Console.log(`\n${c.bold("Missing parameters")} ${c.dim(`(${result.project} / ${result.stage})`)}\n`);

      let created = 0;
      for (const p of missing) {
        const value = yield* Prompt.text({
          message: `${p.ssmPath} ${c.dim(`(${p.handlerName})`)}`,
        });

        if (value.trim() === "") {
          yield* Console.log(`  ${c.dim("skipped")}`);
          continue;
        }

        const setResult = yield* setConfig(p.ssmKey, value);
        if ("error" in setResult) {
          yield* Console.error(`Error: ${setResult.error}`);
          continue;
        }

        yield* Console.log(`  ${c.green("✓")} created`);
        created++;
      }

      if (created > 0) {
        yield* Console.log(`\n  ${c.green(`Created ${created} parameter(s)`)} ${c.dim("(SecureString)")}\n`);
      } else {
        yield* Console.log(`\n  No parameters created.\n`);
      }
    }).pipe(withCliContext(opts))
).pipe(
  Command.withDescription("Manage config values declared via param() in handlers. Run without subcommand to interactively set missing values"),
  Command.withSubcommands([listCommand, setCommand])
);

export const configCommand = configRootCommand;
