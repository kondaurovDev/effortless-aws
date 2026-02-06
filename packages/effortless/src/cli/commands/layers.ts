import { Command, Options } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";
import * as path from "path";
import * as fs from "fs";

import {
  listLayerVersions,
  deleteAllLayerVersions,
  collectLayerPackages,
  readProductionDependencies,
  computeLockfileHash,
  makeClients
} from "@effect-ak/effortless-aws";
import { loadConfig, projectOption, regionOption, verboseOption, outputOption, dryRunOption } from "../config";

const layersCleanupAllOption = Options.boolean("all").pipe(
  Options.withDescription("Delete all layer versions")
);

const layersInfoCommand = Command.make(
  "info",
  { verbose: verboseOption },
  ({ verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);
      const projectDir = process.cwd();

      yield* Console.log("\n=== Layer Packages Preview ===\n");

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

      const allPackages = yield* Effect.promise(() => collectLayerPackages(projectDir, prodDeps));

      yield* Console.log(`\nTotal packages for layer (${allPackages.length}):`);

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

      if (config?.name) {
        yield* Console.log(`\nLayer name: ${config.name}-deps`);
      }
    })
).pipe(Command.withDescription("Preview packages that will be included in layer"));

const layersCleanupCommand = Command.make(
  "cleanup",
  { project: projectOption, region: regionOption, all: layersCleanupAllOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ project: projectOpt, region, all: deleteAll, dryRun, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalRegion = config?.region ?? region;

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      const layerName = `${project}-deps`;

      const clientsLayer = makeClients({
        lambda: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      yield* Effect.gen(function* () {
        yield* Console.log(`\nSearching for layer versions: ${layerName}\n`);

        const versions = yield* listLayerVersions(layerName);

        if (versions.length === 0) {
          yield* Console.log("No layer versions found.");
          return;
        }

        yield* Console.log(`Found ${versions.length} version(s):\n`);

        for (const v of versions) {
          const hash = v.description?.match(/hash:([a-f0-9]+)/)?.[1] ?? "unknown";
          yield* Console.log(`  v${v.version} (hash: ${hash}) - ${v.createdDate ?? "unknown date"}`);
        }

        if (dryRun) {
          yield* Console.log("\n[DRY RUN] No layers were deleted.");
          return;
        }

        if (!deleteAll) {
          yield* Console.log("\nTo delete these layers, use:");
          yield* Console.log("  eff layers cleanup --all        # Delete all versions");
          yield* Console.log("  eff layers cleanup --dry-run    # Preview without deleting");
          return;
        }

        yield* Console.log("\nDeleting layer versions...");
        const deleted = yield* deleteAllLayerVersions(layerName);
        yield* Console.log(`\nDeleted ${deleted} layer version(s).`);
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Delete layer versions"));

const findPackagePathForCopy = (projectDir: string, pkgName: string): string | null => {
  const rootPath = path.join(projectDir, "node_modules", pkgName);
  if (fs.existsSync(rootPath)) {
    try {
      return fs.realpathSync(rootPath);
    } catch {
      // ignore
    }
  }

  const pnpmDir = path.join(projectDir, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;

  const pnpmPkgName = pkgName.replace("/", "+");
  try {
    const entries = fs.readdirSync(pnpmDir);
    for (const entry of entries) {
      if (entry.startsWith(pnpmPkgName + "@")) {
        const pkgPath = path.join(pnpmDir, entry, "node_modules", pkgName);
        if (fs.existsSync(pkgPath)) {
          return fs.realpathSync(pkgPath);
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
};

const layersBuildCommand = Command.make(
  "build",
  { output: outputOption, verbose: verboseOption },
  ({ output, verbose }) =>
    Effect.gen(function* () {
      const projectDir = process.cwd();
      const outputDir = path.isAbsolute(output) ? output : path.resolve(projectDir, output);
      const layerDir = path.join(outputDir, "nodejs", "node_modules");

      const layerRoot = path.join(outputDir, "nodejs");
      if (fs.existsSync(layerRoot)) {
        fs.rmSync(layerRoot, { recursive: true });
      }
      fs.mkdirSync(layerDir, { recursive: true });

      yield* Console.log("\n=== Building Layer Locally ===\n");

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

      const allPackages = yield* Effect.promise(() => collectLayerPackages(projectDir, prodDeps));

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
        const srcPath = findPackagePathForCopy(projectDir, pkgName);
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

      yield* Console.log(`\nLayer built: ${layerRoot}`);
      yield* Console.log(`Packages copied: ${copied}`);
      if (skipped > 0) {
        yield* Console.log(`Packages skipped: ${skipped}`);
      }

      yield* Console.log(`\nTo inspect: ls ${layerDir}`);
    })
).pipe(Command.withDescription("Build layer directory locally (for debugging)"));

export const layersCommand = Command.make("layers").pipe(
  Command.withSubcommands([layersInfoCommand, layersBuildCommand, layersCleanupCommand]),
  Command.withDescription("Manage Lambda layers")
);
