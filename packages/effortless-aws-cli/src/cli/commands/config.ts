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
    yield* Console.error("Error: No 'handlers' patterns in config");
    return yield* Effect.fail(new Error("Missing handler patterns"));
  }

  const files = findHandlerFiles(patterns, projectDir);
  const handlers = yield* discoverHandlers(files, projectDir);
  const params = collectRequiredSecrets(handlers, project, stage);
  return { params, project, stage, region };
});

// ============ eff config list ============

const listHandler = Effect.gen(function* () {
  const ctx = yield* loadRequiredParams;
  const { params } = ctx;

  if (params.length === 0) {
    yield* Console.log("No config parameters declared in handlers.");
    return;
  }

  const { existing, missing } = yield* checkMissingSecrets(params).pipe(
    Effect.provide(Aws.makeClients({ ssm: { region: ctx.region } }))
  );

  yield* Console.log(`\n${c.bold("Config parameters")} ${c.dim(`(${ctx.project} / ${ctx.stage})`)}\n`);

  const all = [
    ...existing.map(p => ({ ...p, status: "set" as const })),
    ...missing.map(p => ({ ...p, status: "missing" as const })),
  ].sort((a, b) => a.handlerName.localeCompare(b.handlerName) || a.ssmKey.localeCompare(b.ssmKey));

  for (const p of all) {
    const icon = p.status === "set" ? c.green("✓") : c.red("✗");
    const label = p.status === "set" ? c.dim("set") : c.red("missing");
    yield* Console.log(`  ${icon} ${c.dim(p.handlerName)}  ${p.ssmPath}  ${label}`);
  }

  const missingCount = missing.length;
  if (missingCount > 0) {
    yield* Console.log(`\n  ${c.yellow(`${missingCount} missing`)} — run ${c.cyan("npx eff config")} to set them`);
  } else {
    yield* Console.log(`\n  ${c.green("All parameters are set.")}`);
  }
  yield* Console.log("");
});

const listCommand = Command.make(
  "list",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) => listHandler.pipe(withCliContext(opts))
).pipe(Command.withDescription("List all declared config parameters and show which are set vs missing"));

// ============ eff config set <key> ============

const setKeyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription("SSM parameter key (e.g. stripe/secret-key)")
);

const setHandler = (key: string) =>
  Effect.gen(function* () {
    const ctx = yield* loadRequiredParams;
    const { params } = ctx;

    const match = params.find(p => p.ssmKey === key);
    if (!match) {
      const available = [...new Set(params.map(p => p.ssmKey))].sort();
      yield* Console.error(`Error: "${key}" is not declared in any handler.`);
      if (available.length > 0) {
        yield* Console.error(`\nAvailable keys:\n${available.map(k => `  - ${k}`).join("\n")}`);
      }
      return yield* Effect.fail(new Error(`Unknown config key: ${key}`));
    }

    const value = yield* Prompt.text({
      message: `Value for ${c.cyan(match.ssmPath)}`,
    });

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

    yield* Console.log(`\n  ${c.green("✓")} ${c.cyan(match.ssmPath)} ${c.dim("(SecureString)")}`);
  });

const setCommand = Command.make(
  "set",
  { key: setKeyArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ key, ...opts }) => setHandler(key).pipe(withCliContext(opts))
).pipe(Command.withDescription("Set a config parameter value (stored encrypted in AWS)"));

// ============ eff config (default — interactive setup) ============

const configHandler = Effect.gen(function* () {
  const ctx = yield* loadRequiredParams;
  const { params } = ctx;

  if (params.length === 0) {
    yield* Console.log("No config parameters declared in handlers.");
    return;
  }

  const { missing } = yield* checkMissingSecrets(params).pipe(
    Effect.provide(Aws.makeClients({ ssm: { region: ctx.region } }))
  );

  if (missing.length === 0) {
    yield* Console.log(`\n  ${c.green("All parameters are set.")} Nothing to do.\n`);
    return;
  }

  yield* Console.log(`\n${c.bold("Missing parameters")} ${c.dim(`(${ctx.project} / ${ctx.stage})`)}\n`);

  let created = 0;
  for (const p of missing) {
    const value = yield* Prompt.text({
      message: `${p.ssmPath} ${c.dim(`(${p.handlerName})`)}`,
    });

    if (value.trim() === "") {
      yield* Console.log(`  ${c.dim("skipped")}`);
      continue;
    }

    yield* ssm.make("put_parameter", {
      Name: p.ssmPath,
      Value: value,
      Type: "SecureString",
      Overwrite: false,
      Tags: ssmTags(ctx.project, ctx.stage, p.handlerName),
    }).pipe(Effect.provide(Aws.makeClients({ ssm: { region: ctx.region } })));

    yield* Console.log(`  ${c.green("✓")} created`);
    created++;
  }

  if (created > 0) {
    yield* Console.log(`\n  ${c.green(`Created ${created} parameter(s)`)} ${c.dim("(SecureString)")}\n`);
  } else {
    yield* Console.log(`\n  No parameters created.\n`);
  }
});

const configRootCommand = Command.make(
  "config",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) => configHandler.pipe(withCliContext(opts))
).pipe(
  Command.withDescription("Manage config values declared via param() in handlers. Run without subcommand to interactively set missing values"),
  Command.withSubcommands([listCommand, setCommand])
);

export const configCommand = configRootCommand;
