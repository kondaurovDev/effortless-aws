import { Args, Command } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";
import * as path from "path";

import { deploy, deployAll, deployTable, deployAllTables, deployProject, type DeployTableResult } from "~/deploy/deploy";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { Aws } from "../../aws";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, noSitesOption, getPatternsFromConfig } from "~/cli/config";
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
        s3: { region: finalRegion },
        cloudfront: { region: "us-east-1" },
        acm: { region: "us-east-1" },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Warning;
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
              noSites,
            });

            const total = results.httpResults.length + results.tableResults.length + results.appResults.length + results.staticSiteResults.length;
            yield* Console.log(`\n${c.green(`Deployed ${total} handler(s):`)}`);

            if (results.apiUrl) {
              yield* Console.log(`\n  API: ${c.cyan(results.apiUrl)}`);
            }

            const summaryLines: { name: string; line: string }[] = [];
            for (const r of results.httpResults) {
              const pathPart = results.apiUrl ? r.url.replace(results.apiUrl, "") : r.url;
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[http]")}  ${c.bold(r.exportName)}  ${c.dim(pathPart)}` });
            }
            for (const r of results.appResults) {
              const pathPart = results.apiUrl ? r.url.replace(results.apiUrl, "") : r.url;
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[app]")}   ${c.bold(r.exportName)}  ${c.dim(pathPart)}` });
            }
            for (const r of results.tableResults) {
              summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[table]")} ${c.bold(r.exportName)}` });
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
                yield* Console.log(`\nAPI Gateway: ${c.cyan(httpResult.apiUrl)}`);
                yield* Console.log(c.green(`Deployed ${httpResult.handlers.length} HTTP handler(s):`));
                for (const r of httpResult.handlers) {
                  yield* Console.log(`  ${c.bold(r.exportName)}: ${c.cyan(r.url)}`);
                }
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

              let foundFile: string | null = null;
              let foundExport: string | null = null;
              let handlerType: "http" | "table" | "app" = "http";

              for (const { file, exports } of discovered.httpHandlers) {
                for (const { exportName } of exports) {
                  if (exportName === targetValue) {
                    foundFile = file;
                    foundExport = exportName;
                    break;
                  }
                }
                if (foundFile) break;
              }

              if (!foundFile) {
                for (const { file, exports } of discovered.tableHandlers) {
                  for (const { exportName } of exports) {
                    if (exportName === targetValue) {
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
                for (const { file, exports } of discovered.appHandlers) {
                  for (const { exportName } of exports) {
                    if (exportName === targetValue) {
                      foundFile = file;
                      foundExport = exportName;
                      handlerType = "app";
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
                  for (const { exportName } of exports) {
                    yield* Console.log(`  ${c.cyan("[http]")}  ${exportName}`);
                  }
                }
                for (const { exports } of discovered.tableHandlers) {
                  for (const { exportName } of exports) {
                    yield* Console.log(`  ${c.cyan("[table]")} ${exportName}`);
                  }
                }
                for (const { exports } of discovered.appHandlers) {
                  for (const { exportName } of exports) {
                    yield* Console.log(`  ${c.cyan("[app]")}   ${exportName}`);
                  }
                }
                return;
              }

              yield* Console.log(`Found handler ${c.bold(targetValue)} in ${c.dim(path.relative(projectDir, foundFile))}`);

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
    })
).pipe(Command.withDescription("Deploy handlers (all from config, by file path, or by handler name)"));
