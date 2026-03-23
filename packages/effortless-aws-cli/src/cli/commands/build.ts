import { Args, Command, Options } from "@effect/cli";
import { Path, FileSystem } from "@effect/platform";
import { Effect, Console, Option } from "effect";

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

// ============ Helpers ============

type BundleAndWriteInput = {
  projectDir: string;
  file: string;
  exportName: string;
  type?: "table" | "api" | "app" | "staticSite" | "fifoQueue" | "bucket" | "mailer" | "cron" | "worker";
  external: string[];
  outputDir: string;
  label: string;
};

const bundleAndWrite = (input: BundleAndWriteInput) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseName = p.basename(input.file, p.extname(input.file));
    const outputName = input.exportName === "default" ? baseName : `${baseName}-${input.exportName}`;
    const outputPath = p.join(input.outputDir, `${outputName}.mjs`);

    yield* Console.log(`Building ${c.cyan(`[${input.label}]`)} ${c.bold(input.exportName)}...`);

    const result = yield* bundle({
      projectDir: input.projectDir,
      file: input.file,
      exportName: input.exportName,
      ...(input.type ? { type: input.type } : {}),
      ...(input.external.length > 0 ? { external: input.external } : {}),
    });

    yield* fs.writeFileString(outputPath, result.code);
    const size = (Buffer.byteLength(result.code) / 1024).toFixed(1);
    yield* Console.log(`  -> ${outputPath} ${c.dim(`(${size} KB)`)}`);
    if (result.topModules) {
      for (const m of result.topModules.slice(0, 5)) {
        yield* Console.log(`     ${c.dim(`${(m.bytes / 1024).toFixed(1)} KB`)}  ${c.dim(m.path)}`);
      }
    }
  });

const resolveExternals = (projectDir: string, extraNodeModules?: string[]) =>
  Effect.gen(function* () {
    const prodDeps = yield* readProductionDependencies(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );
    const { packages: external, warnings } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps, extraNodeModules))
      : { packages: [] as string[], warnings: [] as string[] };

    for (const warning of warnings) {
      yield* Effect.logWarning(`[layer] ${warning}`);
    }

    if (external.length > 0) {
      yield* Console.log(`Using ${external.length} external packages (from layer)\n`);
    }

    return external;
  });

// ============ Build modes ============

const buildAll = (projectDir: string, outputDir: string, external: string[]) =>
  Effect.gen(function* () {
    const config = (yield* ProjectConfig).config;
    const patterns = getPatternsFromConfig(config);
    if (!patterns) {
      yield* Console.error("Error: No file specified and no 'handlers' patterns in config");
      return;
    }

    const files = findHandlerFiles(patterns, projectDir);
    const discovered = yield* discoverHandlers(files, projectDir);

    let builtCount = 0;

    for (const { file, exports } of discovered.apiHandlers) {
      for (const { exportName } of exports) {
        yield* bundleAndWrite({ projectDir, file, exportName, type: "api", external, outputDir, label: "api" });
        builtCount++;
      }
    }

    for (const { file, exports } of discovered.tableHandlers) {
      for (const { exportName } of exports) {
        yield* bundleAndWrite({ projectDir, file, exportName, type: "table", external, outputDir, label: "table" });
        builtCount++;
      }
    }

    yield* Console.log(c.green(`\nBuilt ${builtCount} handler(s) to ${outputDir}`));
  });

const buildFile = (filePath: string, projectDir: string, outputDir: string, external: string[], table: boolean, all: boolean) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fullPath = p.isAbsolute(filePath) ? filePath : p.resolve(projectDir, filePath);
    const type = table ? "table" : "api";
    const label = table ? "table" : "api";

    const configs = yield* (table
      ? extractConfigsFromFile<import("effortless-aws").TableConfig>(fullPath, projectDir, "table")
      : extractConfigsFromFile<import("effortless-aws").ApiConfig>(fullPath, projectDir, "api")
    );

    if (configs.length === 0) {
      yield* Console.error(`No define${table ? "Table" : "Api"} handlers found in file`);
      return;
    }

    const toBundle = all ? configs : [configs[0]!];

    for (const { exportName } of toBundle) {
      yield* bundleAndWrite({ projectDir, file: fullPath, exportName, type, external, outputDir, label });
    }

    yield* Console.log(`\nOutput directory: ${outputDir}`);
  });

// ============ Command ============

export const buildCommand = Command.make(
  "build",
  { file: buildFileArg, all: buildAllOption, table: buildTableOption, output: outputOption, verbose: verboseOption },
  ({ file, all, table, output }) =>
    Effect.gen(function* () {
      const p = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { projectDir, cwd } = yield* ProjectConfig;
      const outputDir = p.isAbsolute(output) ? output : p.resolve(projectDir, output);
      const extraNodeModules = projectDir !== cwd ? [p.join(projectDir, "node_modules")] : undefined;

      const exists = yield* fs.exists(outputDir);
      if (!exists) {
        yield* fs.makeDirectory(outputDir, { recursive: true });
      }

      const external = yield* resolveExternals(projectDir, extraNodeModules);

      yield* Option.match(file, {
        onNone: () => buildAll(projectDir, outputDir, external),
        onSome: (filePath) => buildFile(filePath, projectDir, outputDir, external, table, all),
      });
    }).pipe(Effect.provide(ProjectConfig.Live))
).pipe(Command.withDescription("Build handler bundles locally (for debugging)"));
