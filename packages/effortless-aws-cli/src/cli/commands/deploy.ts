import { Args, Command } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";
import * as path from "path";

import { deploy, deployTable, deployAllTables, deployProject, type DeployTableResult } from "~/deploy/deploy";
import { findHandlerFiles, discoverHandlers, flattenHandlers } from "~/build/bundle";
import { Aws } from "../../aws";
import { projectOption, stageOption, regionOption, verboseOption, noSitesOption, getPatternsFromConfig } from "~/cli/config";
import { ProjectConfig } from "~/cli/project-config";
import { c } from "~/cli/colors";

const deployTargetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Handler name or file path to deploy (optional - uses config patterns if not specified)"),
  Args.optional
);

const isFilePath = (target: string): boolean => {
  return target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js");
};

export const deployCommand = Command.make(
  "deploy",
  { target: deployTargetArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption, noSites: noSitesOption },
  ({ target, project: projectOpt, stage, region, verbose, noSites }) =>
    Effect.gen(function* () {
      const { config, cwd, projectDir } = yield* ProjectConfig;

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      const clientsLayer = Aws.makeClients({
        lambda: { region: finalRegion },
        iam: { region: finalRegion },
        dynamodb: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
        s3: { region: finalRegion },
        cloudfront: { region: "us-east-1" },
        acm: { region: "us-east-1" },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Warning;

      yield* Option.match(target, {
        onNone: () =>
          Effect.gen(function* () {
            const patterns = getPatternsFromConfig(config);
            if (!patterns) {
              yield* Console.error("Error: No target specified and no 'handlers' patterns in config");
              return;
            }

            const results = yield* deployProject({
              projectDir,
              packageDir: cwd,
              patterns,
              project,
              stage: finalStage,
              region: finalRegion,
              noSites,
              verbose,
            });

            const total = results.tableResults.length + results.appResults.length + results.staticSiteResults.length + results.apiResults.length;
            yield* Console.log(`\n${c.green(`Deployed ${total} handler(s):`)}`);

            const summaryLines: { name: string; line: string }[] = [];
            for (const r of results.appResults) {
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[app]")}   ${c.bold(r.exportName)}  ${c.dim(r.url)}` });
            }
            for (const r of results.tableResults) {
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[table]")} ${c.bold(r.exportName)}` });
            }
            for (const r of results.apiResults) {
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[api]")}   ${c.bold(r.exportName)}  ${c.dim(r.url)}` });
            }
            for (const r of results.staticSiteResults) {
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[site]")}  ${c.bold(r.exportName)}: ${c.cyan(r.url)}` });
            }
            summaryLines.sort((a, b) => a.name.localeCompare(b.name));
            for (const { line } of summaryLines) {
              yield* Console.log(line);
            }
          }),
        onSome: (targetValue) =>
          Effect.gen(function* () {
            if (isFilePath(targetValue)) {
              const fullPath = path.isAbsolute(targetValue) ? targetValue : path.resolve(projectDir, targetValue);

              const input = {
                projectDir,
                packageDir: cwd,
                file: fullPath,
                project,
                stage: finalStage,
                region: finalRegion,
              };

              const tableResults = yield* deployAllTables(input).pipe(
                Effect.catchIf(
                  e => e instanceof Error && e.message.includes("No defineTable"),
                  () => Effect.succeed([] as DeployTableResult[])
                )
              );

              if (tableResults.length === 0) {
                yield* Console.error("No handlers found in file");
                return;
              }

              if (tableResults.length > 0) {
                yield* Console.log(c.green(`\nDeployed ${tableResults.length} table handler(s):`));
                for (const r of tableResults) {
                  yield* Console.log(`  ${c.bold(r.exportName)}: ${c.dim(r.tableArn)}`);
                }
              }
            } else {
              const patterns = getPatternsFromConfig(config);
              if (!patterns) {
                yield* Console.error("Error: No 'handlers' patterns in config to search for handler name");
                return;
              }

              const files = findHandlerFiles(patterns, projectDir);
              const discovered = discoverHandlers(files);

              const allHandlers = flattenHandlers(discovered);
              const found = allHandlers.find(h => h.exportName === targetValue);

              if (!found) {
                yield* Console.error(`Error: Handler "${targetValue}" not found`);
                yield* Console.log("\nAvailable handlers:");
                for (const h of allHandlers) {
                  yield* Console.log(`  ${c.cyan(`[${h.type}]`.padEnd(9))} ${h.exportName}`);
                }
                return;
              }

              const foundFile = found.file;
              const foundExport = found.exportName;
              const handlerType = found.type;

              yield* Console.log(`Found handler ${c.bold(targetValue)} in ${c.dim(path.relative(projectDir, foundFile))}`);

              const input = {
                projectDir,
                packageDir: cwd,
                file: foundFile,
                project,
                stage: finalStage,
                region: finalRegion,
                exportName: foundExport,
              };

              if (handlerType === "table") {
                const result = yield* deployTable(input);
                yield* Console.log(`\n${c.green("Table deployed:")} ${c.dim(result.tableArn)}`);
              } else {
                // Both http and app handlers deploy via the same deploy() path
                const result = yield* deploy(input);
                yield* Console.log(`\n${c.green("Deployed:")} ${c.cyan(result.url)}`);
              }
            }
          }),
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    }).pipe(Effect.provide(ProjectConfig.Live))
).pipe(Command.withDescription("Deploy handlers to AWS Lambda. Accepts a handler name, file path, or deploys all from config"));
