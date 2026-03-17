import { Args, Command } from "@effect/cli";
import { Prompt } from "@effect/cli";
import type { Terminal } from "@effect/platform/Terminal";
import { Effect, Console, Logger, LogLevel, Option } from "effect";

import { Aws } from "../../aws";
import { ssm } from "~/aws/clients";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { resolveStage } from "~/aws";
import { collectRequiredSecrets, checkMissingSecrets, type RequiredSecret } from "~/deploy/resolve-config";
import { projectOption, stageOption, regionOption, verboseOption, getPatternsFromConfig } from "~/cli/config";
import { ProjectConfig } from "~/cli/project-config";
import { c } from "~/cli/colors";
import { toAwsTagList } from "~/aws/tags";

// ============ Shared helpers ============

const ssmTags = (project: string, stage: string, handlerName: string) =>
  toAwsTagList({
    "effortless:project": project,
    "effortless:stage": stage,
    "effortless:handler": handlerName,
    "effortless:type": "ssm-parameter",
  });

const loadRequiredParams = (
  projectOpt: Option.Option<string>,
  stage: string,
  region: string,
) =>
  Effect.gen(function* () {
    const { config, projectDir } = yield* ProjectConfig;
    const project = Option.getOrElse(projectOpt, () => config?.name ?? "");

    if (!project) {
      yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
      return yield* Effect.fail(new Error("Missing project name"));
    }

    const patterns = getPatternsFromConfig(config);
    if (!patterns) {
      yield* Console.error("Error: No 'handlers' patterns in config");
      return yield* Effect.fail(new Error("Missing handler patterns"));
    }

    const files = findHandlerFiles(patterns, projectDir);
    const handlers = yield* Effect.promise(() => discoverHandlers(files, projectDir));
    const finalStage = config?.stage ?? stage;
    const finalRegion = config?.region ?? region;

    const params = collectRequiredSecrets(handlers, project, finalStage);
    return { params, project, stage: finalStage, region: finalRegion };
  });

// ============ eff config list ============

const listCommand = Command.make(
  "list",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, verbose }) =>
    Effect.gen(function* () {
      const ctx = yield* loadRequiredParams(projectOpt, stage, region);
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
    }).pipe(
      Effect.provide(ProjectConfig.Live),
      Logger.withMinimumLogLevel(LogLevel.Warning)
    )
).pipe(Command.withDescription("List all declared config parameters and show which are set vs missing"));

// ============ eff config set <key> ============

const setKeyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription("SSM parameter key (e.g. stripe/secret-key)")
);

const setCommand = Command.make(
  "set",
  { key: setKeyArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ key, project: projectOpt, stage, region, verbose }) =>
    Effect.gen(function* () {
      const ctx = yield* loadRequiredParams(projectOpt, stage, region);
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
    }).pipe(
      Effect.provide(ProjectConfig.Live),
      Logger.withMinimumLogLevel(LogLevel.Warning)
    )
).pipe(Command.withDescription("Set a config parameter value (stored encrypted in AWS)"));

// ============ eff config (default — interactive setup) ============

const configRootCommand = Command.make(
  "config",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, verbose }) =>
    Effect.gen(function* () {
      const ctx = yield* loadRequiredParams(projectOpt, stage, region);
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
    }).pipe(
      Effect.provide(ProjectConfig.Live),
      Logger.withMinimumLogLevel(LogLevel.Warning)
    )
).pipe(
  Command.withDescription("Manage config values declared via param() in handlers. Run without subcommand to interactively set missing values"),
  Command.withSubcommands([listCommand, setCommand])
);

export const configCommand = configRootCommand;
