import { Command, Options } from "@effect/cli";
import { Effect, Console } from "effect";
import * as path from "path";
import * as fs from "fs";

import {
  collectLayerPackages,
  readProductionDependencies,
  computeLockfileHash
} from "../../aws";
import { loadConfig, verboseOption, outputOption } from "~/cli/config";
import { c } from "~/cli/colors";

const buildOption = Options.boolean("build").pipe(
  Options.withDescription("Build layer directory locally (for debugging)")
);

export const layerCommand = Command.make(
  "layer",
  { build: buildOption, output: outputOption, verbose: verboseOption },
  ({ build, output, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);
      const projectDir = process.cwd();

      if (build) {
        yield* buildLayer(projectDir, output, verbose);
      } else {
        yield* showLayerInfo(projectDir, config?.name, verbose);
      }
    })
).pipe(Command.withDescription("Show or build the dependency layer"));

const showLayerInfo = (projectDir: string, projectName: string | undefined, verbose: boolean) =>
  Effect.gen(function* () {
    yield* Console.log(`\n${c.bold("=== Layer Packages Preview ===")}\n`);

    const prodDeps = yield* readProductionDependencies(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );

    if (prodDeps.length === 0) {
      yield* Console.log("No production dependencies found in package.json");
      yield* Console.log("Layer will not be created.");
      return;
    }

    yield* Console.log(`Production dependencies (${prodDeps.length}):`);
    for (const dep of prodDeps) {
      yield* Console.log(`  ${dep}`);
    }

    const hash = yield* computeLockfileHash(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );

    if (hash) {
      yield* Console.log(`\nLockfile hash: ${hash}`);
    } else {
      yield* Console.log("\nNo lockfile found (package-lock.json, pnpm-lock.yaml, or yarn.lock)");
    }

    const { packages: allPackages, warnings: layerWarnings } = yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps));

    if (layerWarnings.length > 0) {
      yield* Console.log(c.yellow(`\nWarnings (${layerWarnings.length}):`));
      for (const w of layerWarnings) {
        yield* Console.log(c.yellow(`  ⚠ ${w}`));
      }
    }

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
    const outputDir = path.isAbsolute(output) ? output : path.resolve(projectDir, output);
    const layerDir = path.join(outputDir, "nodejs", "node_modules");

    const layerRoot = path.join(outputDir, "nodejs");
    if (fs.existsSync(layerRoot)) {
      fs.rmSync(layerRoot, { recursive: true });
    }
    fs.mkdirSync(layerDir, { recursive: true });

    yield* Console.log(`\n${c.bold("=== Building Layer Locally ===")}\n`);

    const prodDeps = yield* readProductionDependencies(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );

    if (prodDeps.length === 0) {
      yield* Console.log("No production dependencies found in package.json");
      yield* Console.log("Layer will not be created.");
      return;
    }

    yield* Console.log(`Production dependencies (${prodDeps.length}):`);
    for (const dep of prodDeps) {
      yield* Console.log(`  ${dep}`);
    }

    const hash = yield* computeLockfileHash(projectDir).pipe(
      Effect.catchAll(() => Effect.succeed("unknown"))
    );

    yield* Console.log(`\nLockfile hash: ${hash}`);

    const { packages: allPackages, resolvedPaths, warnings: layerWarnings } = yield* Effect.sync(() => collectLayerPackages(projectDir, prodDeps));

    if (layerWarnings.length > 0) {
      yield* Console.log(`\nWarnings (${layerWarnings.length}):`);
      for (const w of layerWarnings) {
        yield* Console.log(`  ⚠ ${w}`);
      }
    }

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

      const destPath = path.join(layerDir, pkgName);

      if (pkgName.startsWith("@")) {
        const scopeDir = path.join(layerDir, pkgName.split("/")[0] ?? pkgName);
        if (!fs.existsSync(scopeDir)) {
          fs.mkdirSync(scopeDir, { recursive: true });
        }
      }

      fs.cpSync(srcPath, destPath, { recursive: true });
      copied++;
    }

    yield* Console.log(c.green(`\nLayer built: ${layerRoot}`));
    yield* Console.log(`Packages copied: ${c.green(String(copied))}`);
    if (skipped > 0) {
      yield* Console.log(`Packages skipped: ${c.yellow(String(skipped))}`);
    }

    yield* Console.log(`\nTo inspect: ls ${layerDir}`);
  });
