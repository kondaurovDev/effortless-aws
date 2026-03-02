import { Args, Command, Options } from "@effect/cli";
import { Effect, Console, Option } from "effect";
import * as path from "path";
import * as fs from "fs";

import { bundle, extractConfigs, extractTableConfigs, findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { collectLayerPackages, readProductionDependencies } from "../../aws";
import { loadConfig, verboseOption, outputOption, getPatternsFromConfig } from "~/cli/config";
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
      const config = yield* Effect.promise(loadConfig);
      const projectDir = process.cwd();
      const outputDir = path.isAbsolute(output) ? output : path.resolve(projectDir, output);

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const prodDeps = yield* readProductionDependencies(projectDir).pipe(
        Effect.catchAll(() => Effect.succeed([] as string[]))
      );
      const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
        ? yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps))
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
            const discovered = discoverHandlers(files);

            let builtCount = 0;

            for (const { file: handlerFile, exports } of discovered.httpHandlers) {
              const relativePath = path.relative(projectDir, handlerFile);
              const baseName = path.basename(handlerFile, path.extname(handlerFile));

              for (const { exportName } of exports) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[http]")} ${c.bold(relativePath)}:${exportName}...`);

                const bundled = yield* bundle({
                  projectDir,
                  file: handlerFile,
                  exportName,
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, bundled);
                const size = (Buffer.byteLength(bundled) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
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

                const bundled = yield* bundle({
                  projectDir,
                  file: handlerFile,
                  exportName,
                  type: "table",
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, bundled);
                const size = (Buffer.byteLength(bundled) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
                builtCount++;
              }
            }

            yield* Console.log(c.green(`\nBuilt ${builtCount} handler(s) to ${outputDir}`));
          }),
        onSome: (filePath) =>
          Effect.gen(function* () {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath);
            const source = fs.readFileSync(fullPath, "utf-8");
            const baseName = path.basename(fullPath, path.extname(fullPath));

            if (table) {
              const configs = extractTableConfigs(source);
              if (configs.length === 0) {
                yield* Console.error("No defineTable handlers found in file");
                return;
              }

              const toBundle = all ? configs : [configs[0]!];

              for (const { exportName } of toBundle) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[table]")} ${c.bold(exportName)}...`);

                const bundled = yield* bundle({
                  projectDir,
                  file: fullPath,
                  exportName,
                  type: "table",
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, bundled);
                const size = (Buffer.byteLength(bundled) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
              }
            } else {
              const configs = extractConfigs(source);
              if (configs.length === 0) {
                yield* Console.error("No defineHttp handlers found in file");
                return;
              }

              const toBundle = all ? configs : [configs[0]!];

              for (const { exportName } of toBundle) {
                const outputName = exportName === "default" ? baseName : `${baseName}-${exportName}`;
                const outputPath = path.join(outputDir, `${outputName}.mjs`);

                yield* Console.log(`Building ${c.cyan("[http]")} ${c.bold(exportName)}...`);

                const bundled = yield* bundle({
                  projectDir,
                  file: fullPath,
                  exportName,
                  ...(external.length > 0 ? { external } : {})
                });

                fs.writeFileSync(outputPath, bundled);
                const size = (Buffer.byteLength(bundled) / 1024).toFixed(1);
                yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
              }
            }

            yield* Console.log(`\nOutput directory: ${outputDir}`);
          }),
      });
    })
).pipe(Command.withDescription("Build handler bundles locally (for debugging)"));
