import { Args, Command, Options } from "@effect/cli";
import { Effect, Console, Option } from "effect";
import * as path from "path";
import * as fs from "fs";

import { bundle, extractConfigsFromFile, findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { collectLayerPackages, readProductionDependencies } from "../../aws";
import { verboseOption, outputOption, getPatternsFromConfig } from "~/cli/config";
import { ProjectConfig } from "~/cli/project-config";
import { c } from "~/cli/colors";

const buildFileArg = Args.file({ name: "file", exists: "yes" }).pipe(
  Args.withDescription("Handler file to build"),
  Args.optional
);

const buildAllOption = Options.boolean("all").pipe(
  Options.withDescription("Build all exports from file")
);

const buildTableOption = Options.boolean("table").pipe(
  Options.withDescription("Build as table handler (defineTable)")
);

export const buildCommand = Command.make(
  "build",
  { file: buildFileArg, all: buildAllOption, table: buildTableOption, output: outputOption, verbose: verboseOption },
  ({ file, all, table, output, verbose }) =>
    Effect.gen(function* () {
      const { config, projectDir, cwd } = yield* ProjectConfig;
      const outputDir = path.isAbsolute(output) ? output : path.resolve(projectDir, output);
      const extraNodeModules = projectDir !== cwd ? [path.join(projectDir, "node_modules")] : undefined;

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const prodDeps = yield* readProductionDependencies(projectDir).pipe(
        Effect.catchAll(() => Effect.succeed([] as string[]))
      );
      const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
        ? yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps, extraNodeModules))
        : { packages: [] as string[], warnings: [] as string[] };

      for (const warning of layerWarnings) {
        yield* Effect.logWarning(`[layer] ${warning}`);
      }

      if (external.length > 0) {
        yield* Console.log(`Using ${external.length} external packages (from layer)\n`);
      }

      yield* Option.match(file, {
        onNone: () =>
          Effect.gen(function* () {
            const patterns = getPatternsFromConfig(config);
            if (!patterns) {
              yield* Console.error("Error: No file specified and no 'handlers' patterns in config");
              return;
            }

            const files = findHandlerFiles(patterns, projectDir);
            const discovered = yield* Effect.promise(() => discoverHandlers(files, projectDir));

            let builtCount = 0;

            for (const { file: handlerFile, exports } of discovered.apiHandlers) {
              const relativePath = path.relative(projectDir, handlerFile);
              const baseName = path.basename(handlerFile, path.extname(handlerFile));

              for (const { exportName } of exports) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[api]")} ${c.bold(relativePath)}:${exportName}...`);

                const result = yield* bundle({
                  projectDir,
                  file: handlerFile,
                  exportName,
                  type: "api",
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, result.code);
                const size = (Buffer.byteLength(result.code) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
                if (result.topModules) {
                  for (const m of result.topModules.slice(0, 5)) {
                    yield* Console.log(`     ${c.dim(`${(m.bytes / 1024).toFixed(1)} KB`)}  ${c.dim(m.path)}`);
                  }
                }
                builtCount++;
              }
            }

            for (const { file: handlerFile, exports } of discovered.tableHandlers) {
              const relativePath = path.relative(projectDir, handlerFile);
              const baseName = path.basename(handlerFile, path.extname(handlerFile));

              for (const { exportName } of exports) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[table]")} ${c.bold(relativePath)}:${exportName}...`);

                const result = yield* bundle({
                  projectDir,
                  file: handlerFile,
                  exportName,
                  type: "table",
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, result.code);
                const size = (Buffer.byteLength(result.code) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
                if (result.topModules) {
                  for (const m of result.topModules.slice(0, 5)) {
                    yield* Console.log(`     ${c.dim(`${(m.bytes / 1024).toFixed(1)} KB`)}  ${c.dim(m.path)}`);
                  }
                }
                builtCount++;
              }
            }

            yield* Console.log(c.green(`\nBuilt ${builtCount} handler(s) to ${outputDir}`));
          }),
        onSome: (filePath) =>
          Effect.gen(function* () {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath);
            const baseName = path.basename(fullPath, path.extname(fullPath));

            if (table) {
              const configs = yield* Effect.promise(() => extractConfigsFromFile<import("effortless-aws").TableConfig>(fullPath, projectDir, "table"));
              if (configs.length === 0) {
                yield* Console.error("No defineTable handlers found in file");
                return;
              }

              const toBundle = all ? configs : [configs[0]!];

              for (const { exportName } of toBundle) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[table]")} ${c.bold(exportName)}...`);

                const result = yield* bundle({
                  projectDir,
                  file: fullPath,
                  exportName,
                  type: "table",
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, result.code);
                const size = (Buffer.byteLength(result.code) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
                if (result.topModules) {
                  for (const m of result.topModules.slice(0, 5)) {
                    yield* Console.log(`     ${c.dim(`${(m.bytes / 1024).toFixed(1)} KB`)}  ${c.dim(m.path)}`);
                  }
                }
              }
            } else {
              const configs = yield* Effect.promise(() => extractConfigsFromFile<import("effortless-aws").ApiConfig>(fullPath, projectDir, "api"));
              if (configs.length === 0) {
                yield* Console.error("No defineApi handlers found in file");
                return;
              }

              const toBundle = all ? configs : [configs[0]!];

              for (const { exportName } of toBundle) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[api]")} ${c.bold(exportName)}...`);

                const result = yield* bundle({
                  projectDir,
                  file: fullPath,
                  exportName,
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, result.code);
                const size = (Buffer.byteLength(result.code) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
                if (result.topModules) {
                  for (const m of result.topModules.slice(0, 5)) {
                    yield* Console.log(`     ${c.dim(`${(m.bytes / 1024).toFixed(1)} KB`)}  ${c.dim(m.path)}`);
                  }
                }
              }
            }

            yield* Console.log(`\nOutput directory: ${outputDir}`);
          }),
      });
    }).pipe(Effect.provide(ProjectConfig.Live))
).pipe(Command.withDescription("Build handler bundles locally (for debugging)"));
