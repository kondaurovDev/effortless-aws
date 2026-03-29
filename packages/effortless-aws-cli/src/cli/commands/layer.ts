import { Command, Options } from "@effect/cli";
import { Path, FileSystem } from "@effect/platform";
import { Effect, Console } from "effect";

import {
  collectLayerPackages,
  readProductionDependencies,
  computeLockfileHash,
  checkDependencyWarnings,
  findDepsDir,
} from "../../aws";
import { verboseOption, outputOption, getPatternsFromConfig } from "~/cli/config";
import { findHandlerFiles } from "~/build/bundle";
import { ProjectConfig } from "~/cli/project-config";
import { c } from "~/cli/colors";
import * as path from "path";

const buildOption = Options.boolean("build").pipe(
  Options.withDescription("Build layer directory locally (for debugging)")
);

// ============ Layer data (pure — no side effects) ============

export type LayerInfoResult = {
  projectName: string | undefined;
  layerName: string | undefined;
  prodDeps: string[];
  packages: string[];
  lockfileHash: string | null;
  warnings: string[];
};

/** Resolve the directory containing runtime dependencies (may differ from projectDir in monorepos). */
const resolveDepsDir = (projectDir: string, config: { handlers?: string | string[] } | null): string => {
  const patterns = getPatternsFromConfig(config as any);
  if (!patterns) return projectDir;
  const files = findHandlerFiles(patterns, projectDir);
  if (files.length === 0) return projectDir;
  return findDepsDir(path.dirname(files[0]!), projectDir);
};

/** Get layer info: production deps, packages, hash. No Console output. */
export const getLayerInfo = Effect.gen(function* () {
  const { config, projectDir } = yield* ProjectConfig;
  const depsDir = resolveDepsDir(projectDir, config);

  const prodDeps = yield* readProductionDependencies(depsDir).pipe(
    Effect.catchAll(() => Effect.succeed([] as string[]))
  );

  const hash = yield* computeLockfileHash(depsDir).pipe(
    Effect.catchAll(() => Effect.succeed(null))
  );

  const { packages, warnings } = prodDeps.length > 0
    ? yield* Effect.sync(() => collectLayerPackages(depsDir, prodDeps))
    : { packages: [] as string[], warnings: [] as string[] };

  const depWarnings = yield* checkDependencyWarnings(depsDir).pipe(
    Effect.catchAll(() => Effect.succeed([] as string[]))
  );

  return {
    projectName: config?.name,
    layerName: config?.name ? `${config.name}-deps` : undefined,
    prodDeps,
    packages: packages.sort(),
    lockfileHash: hash,
    warnings: [...depWarnings, ...warnings],
  } satisfies LayerInfoResult;
});

// ============ Shared helpers ============

const printDepWarnings = (projectDir: string) =>
  Effect.gen(function* () {
    const warnings = yield* checkDependencyWarnings(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );
    for (const w of warnings) {
      yield* Console.log(c.yellow(`  ⚠ ${w}`));
    }
    if (warnings.length > 0) yield* Console.log("");
  });

const loadProdDeps = (projectDir: string) =>
  Effect.gen(function* () {
    const prodDeps = yield* readProductionDependencies(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );

    if (prodDeps.length === 0) {
      yield* Console.log("No production dependencies found in package.json");
      yield* Console.log("Layer will not be created.");
      return null;
    }

    yield* Console.log(`Production dependencies (${prodDeps.length}):`);
    for (const dep of prodDeps) {
      yield* Console.log(`  ${dep}`);
    }

    return prodDeps;
  });

const printLayerWarnings = (warnings: string[]) =>
  Effect.gen(function* () {
    if (warnings.length > 0) {
      yield* Console.log(c.yellow(`\nWarnings (${warnings.length}):`));
      for (const w of warnings) {
        yield* Console.log(c.yellow(`  ⚠ ${w}`));
      }
    }
  });

// ============ Layer modes ============

const showLayerInfo = (projectDir: string, projectName: string | undefined, verbose: boolean) =>
  Effect.gen(function* () {
    yield* Console.log(`\n${c.bold("=== Layer Packages Preview ===")}\n`);
    yield* Effect.logDebug(`Dependencies dir: ${projectDir}`);
    yield* Effect.logDebug(`package.json: ${path.join(projectDir, "package.json")}`);

    yield* printDepWarnings(projectDir);
    const prodDeps = yield* loadProdDeps(projectDir);
    if (!prodDeps) return;

    const hash = yield* computeLockfileHash(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );

    if (hash) {
      yield* Console.log(`\nLockfile hash: ${hash}`);
    } else {
      yield* Console.log("\nNo lockfile found (package-lock.json, pnpm-lock.yaml, or yarn.lock)");
    }

    const { packages: allPackages, warnings } = yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps));
    yield* printLayerWarnings(warnings);

    yield* Console.log(`\nTotal packages for layer ${c.dim(`(${allPackages.length})`)}:`);

    if (verbose) {
      for (const pkg of allPackages.sort()) {
        yield* Console.log(`  ${pkg}`);
      }
    } else {
      const sorted = allPackages.sort();
      const shown = sorted.slice(0, 20);
      for (const pkg of shown) {
        yield* Console.log(`  ${pkg}`);
      }
      if (sorted.length > 20) {
        yield* Console.log(`  ... and ${sorted.length - 20} more (use --verbose to see all)`);
      }
    }

    if (projectName) {
      yield* Console.log(`\nLayer name: ${projectName}-deps`);
    }
  });

const buildLayer = (projectDir: string, output: string, verbose: boolean) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    const outputDir = p.isAbsolute(output) ? output : p.resolve(projectDir, output);
    const layerDir = p.join(outputDir, "nodejs", "node_modules");
    const layerRoot = p.join(outputDir, "nodejs");

    const layerRootExists = yield* fs.exists(layerRoot);
    if (layerRootExists) {
      yield* fs.remove(layerRoot, { recursive: true });
    }
    yield* fs.makeDirectory(layerDir, { recursive: true });

    yield* Console.log(`\n${c.bold("=== Building Layer Locally ===")}\n`);

    yield* printDepWarnings(projectDir);
    const prodDeps = yield* loadProdDeps(projectDir);
    if (!prodDeps) return;

    const hash = yield* computeLockfileHash(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed("unknown"))
    );
    yield* Console.log(`\nLockfile hash: ${hash}`);

    const { packages: allPackages, resolvedPaths, warnings } = yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps));
    yield* printLayerWarnings(warnings);

    yield* Console.log(`\nCollected ${allPackages.length} packages for layer`);

    if (verbose) {
      for (const pkg of allPackages.sort()) {
        yield* Console.log(`  ${pkg}`);
      }
    }

    yield* Console.log("\nCopying packages...");

    let copied = 0;
    let skipped = 0;

    for (const pkgName of allPackages) {
      const srcPath = resolvedPaths.get(pkgName) ?? null;
      if (!srcPath) {
        skipped++;
        if (verbose) {
          yield* Console.log(`  [skip] ${pkgName} (not found)`);
        }
        continue;
      }

      const destPath = p.join(layerDir, pkgName);

      if (pkgName.startsWith("@")) {
        const scopeDir = p.join(layerDir, pkgName.split("/")[0] ?? pkgName);
        const scopeExists = yield* fs.exists(scopeDir);
        if (!scopeExists) {
          yield* fs.makeDirectory(scopeDir, { recursive: true });
        }
      }

      yield* fs.copy(srcPath, destPath);
      copied++;
    }

    yield* Console.log(c.green(`\nLayer built: ${layerRoot}`));
    yield* Console.log(`Packages copied: ${c.green(String(copied))}`);
    if (skipped > 0) {
      yield* Console.log(`Packages skipped: ${c.yellow(String(skipped))}`);
    }

    yield* Console.log(`\nTo inspect: ls ${layerDir}`);
  });

// ============ Command ============

export const layerCommand = Command.make(
  "layer",
  { build: buildOption, output: outputOption, verbose: verboseOption },
  ({ build, output, verbose }) =>
    Effect.gen(function* () {
      const { config, projectDir } = yield* ProjectConfig;
      const depsDir = resolveDepsDir(projectDir, config);

      if (build) {
        yield* buildLayer(depsDir, output, verbose);
      } else {
        yield* showLayerInfo(depsDir, config?.name, verbose);
      }
    }).pipe(Effect.provide(ProjectConfig.Live))
).pipe(Command.withDescription("Inspect or locally build the shared Lambda dependency layer from package.json"));
