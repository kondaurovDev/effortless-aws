import { Args, Command } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";
import * as path from "path";

import { deploy, deployAll, deployTable, deployAllTables, deployProject, type DeployTableResult } from "~/deploy/deploy";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { Aws } from "../../aws";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, getPatternsFromConfig } from "~/cli/config";

const deployTargetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Handler name or file path to deploy (optional - uses config patterns if not specified)"),
  Args.optional
);

const isFilePath = (target: string): boolean => {
  return target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js");
};

export const deployCommand = Command.make(
  "deploy",
  { target: deployTargetArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ target, project: projectOpt, stage, region, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

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
        apigatewayv2: { region: finalRegion },
        dynamodb: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;
      const projectDir = process.cwd();

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
              patterns,
              project,
              stage: finalStage,
              region: finalRegion,
            });

            const total = results.httpResults.length + results.tableResults.length + results.siteResults.length;
            yield* Console.log(`\nDeployed ${total} handler(s):`);
            for (const r of results.httpResults) {
              yield* Console.log(`  [http] ${r.exportName}: ${r.url}`);
            }
            for (const r of results.tableResults) {
              yield* Console.log(`  [table] ${r.exportName}: ${r.tableArn}`);
            }
            for (const r of results.siteResults) {
              yield* Console.log(`  [site] ${r.exportName}: ${r.url}`);
            }
          }),
        onSome: (targetValue) =>
          Effect.gen(function* () {
            if (isFilePath(targetValue)) {
              const fullPath = path.isAbsolute(targetValue) ? targetValue : path.resolve(projectDir, targetValue);

              const input = {
                projectDir,
                file: fullPath,
                project,
                stage: finalStage,
                region: finalRegion,
              };

              const httpResult = yield* deployAll(input).pipe(
                Effect.catchIf(
                  e => e instanceof Error && e.message.includes("No defineHttp"),
                  () => Effect.succeed(null)
                )
              );

              const tableResults = yield* deployAllTables(input).pipe(
                Effect.catchIf(
                  e => e instanceof Error && e.message.includes("No defineTable"),
                  () => Effect.succeed([] as DeployTableResult[])
                )
              );

              if (!httpResult && tableResults.length === 0) {
                yield* Console.error("No handlers found in file");
                return;
              }

              if (httpResult) {
                yield* Console.log(`\nAPI Gateway: ${httpResult.apiUrl}`);
                yield* Console.log(`Deployed ${httpResult.handlers.length} HTTP handler(s):`);
                for (const r of httpResult.handlers) {
                  yield* Console.log(`  ${r.exportName}: ${r.url}`);
                }
              }

              if (tableResults.length > 0) {
                yield* Console.log(`\nDeployed ${tableResults.length} table handler(s):`);
                for (const r of tableResults) {
                  yield* Console.log(`  ${r.exportName}: ${r.tableArn}`);
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

              let foundFile: string | null = null;
              let foundExport: string | null = null;
              let handlerType: "http" | "table" | "site" = "http";

              for (const { file, exports } of discovered.httpHandlers) {
                for (const { exportName, config: handlerConfig } of exports) {
                  if (handlerConfig.name === targetValue) {
                    foundFile = file;
                    foundExport = exportName;
                    break;
                  }
                }
                if (foundFile) break;
              }

              if (!foundFile) {
                for (const { file, exports } of discovered.tableHandlers) {
                  for (const { exportName, config: handlerConfig } of exports) {
                    if (handlerConfig.name === targetValue) {
                      foundFile = file;
                      foundExport = exportName;
                      handlerType = "table";
                      break;
                    }
                  }
                  if (foundFile) break;
                }
              }

              if (!foundFile) {
                for (const { file, exports } of discovered.siteHandlers) {
                  for (const { exportName, config: handlerConfig } of exports) {
                    if (handlerConfig.name === targetValue) {
                      foundFile = file;
                      foundExport = exportName;
                      handlerType = "site";
                      break;
                    }
                  }
                  if (foundFile) break;
                }
              }

              if (!foundFile || !foundExport) {
                yield* Console.error(`Error: Handler "${targetValue}" not found`);
                yield* Console.log("\nAvailable handlers:");
                for (const { exports } of discovered.httpHandlers) {
                  for (const { config: c } of exports) {
                    yield* Console.log(`  [http] ${c.name}`);
                  }
                }
                for (const { exports } of discovered.tableHandlers) {
                  for (const { config: c } of exports) {
                    yield* Console.log(`  [table] ${c.name}`);
                  }
                }
                for (const { exports } of discovered.siteHandlers) {
                  for (const { config: c } of exports) {
                    yield* Console.log(`  [site] ${c.name}`);
                  }
                }
                return;
              }

              yield* Console.log(`Found handler "${targetValue}" in ${path.relative(projectDir, foundFile)}`);

              const input = {
                projectDir,
                file: foundFile,
                project,
                stage: finalStage,
                region: finalRegion,
                exportName: foundExport,
              };

              if (handlerType === "table") {
                const result = yield* deployTable(input);
                yield* Console.log(`\nTable deployed: ${result.tableArn}`);
              } else {
                // Both http and site handlers deploy via the same deploy() path
                const result = yield* deploy(input);
                yield* Console.log(`\nDeployed: ${result.url}`);
              }
            }
          }),
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Deploy handlers (all from config, by file path, or by handler name)"));
