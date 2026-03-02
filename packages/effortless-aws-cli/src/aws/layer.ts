import { Effect } from "effect";
import { Architecture, Runtime } from "@aws-sdk/client-lambda";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import archiver from "archiver";
import { lambda } from "./clients";

// Fixed date for deterministic zip (same content = same hash)
const FIXED_DATE = new Date(0);

export type LayerConfig = {
  project: string;
  stage: string;
  region: string;
  projectDir: string;
  tags?: Record<string, string>;
};

export type LayerStatus = "created" | "cached";

export type LayerResult = {
  layerArn: string;
  layerVersionArn: string;
  version: number;
  lockfileHash: string;
  status: LayerStatus;
};

/**
 * Get version of a package from its package.json
 */
const getPackageVersion = (pkgPath: string): string | null => {
  const pkgJsonPath = path.join(pkgPath, "package.json");
  if (!fsSync.existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(fsSync.readFileSync(pkgJsonPath, "utf-8"));
    return pkgJson.version ?? null;
  } catch {
    return null;
  }
};

/**
 * Compute hash based on production dependencies only.
 * This ensures the layer is only recreated when prod deps change,
 * not when dev deps are updated.
 */
export const computeLockfileHash = (projectDir: string) =>
  Effect.gen(function* () {
    const prodDeps = yield* readProductionDependencies(projectDir);

    if (prodDeps.length === 0) {
      return yield* Effect.fail(new Error("No production dependencies"));
    }

    // Collect all transitive production packages
    const { packages: allPackages, resolvedPaths } = collectTransitiveDeps(projectDir, prodDeps);

    // Build a sorted list of package@version pairs
    const packageVersions: string[] = [];
    for (const pkgName of Array.from(allPackages).sort()) {
      const pkgPath = resolvedPaths.get(pkgName)
        ?? findInPnpmStore(projectDir, pkgName)
        ?? getPackageRealPath(projectDir, pkgName);

      if (pkgPath) {
        const version = getPackageVersion(pkgPath);
        if (version) {
          packageVersions.push(`${pkgName}@${version}`);
        }
      }
    }

    if (packageVersions.length === 0) {
      return yield* Effect.fail(new Error("No package versions found"));
    }

    // Hash the sorted package versions
    const content = packageVersions.join("\n");
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 8);
  });

/**
 * Read production dependencies from package.json
 */
export const readProductionDependencies = (projectDir: string) =>
  Effect.gen(function* () {
    const pkgPath = path.join(projectDir, "package.json");
    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(pkgPath, "utf-8"),
      catch: () => new Error(`Cannot read package.json at ${pkgPath}`)
    });
    const pkg = JSON.parse(content);
    return Object.keys(pkg.dependencies ?? {});
  });


/**
 * Get the real path of a package in node_modules, following symlinks (pnpm support)
 */
const getPackageRealPath = (projectDir: string, pkgName: string): string | null => {
  const pkgPath = path.join(projectDir, "node_modules", pkgName);
  if (!fsSync.existsSync(pkgPath)) return null;

  try {
    return fsSync.realpathSync(pkgPath);
  } catch {
    return null;
  }
};


type PackageDeps = {
  required: string[];
  optional: string[];
  all: string[];
};

const EMPTY_DEPS: PackageDeps = { required: [], optional: [], all: [] };

/**
 * Get all dependencies from a package's package.json, categorized by type.
 * `required` = dependencies, `optional` = optionalDependencies + peerDependencies.
 */
const getPackageDeps = (pkgPath: string): PackageDeps => {
  const pkgJsonPath = path.join(pkgPath, "package.json");
  if (!fsSync.existsSync(pkgJsonPath)) return EMPTY_DEPS;

  try {
    const pkgJson = JSON.parse(fsSync.readFileSync(pkgJsonPath, "utf-8"));
    const required = Object.keys(pkgJson.dependencies ?? {});
    const optionalDeps = Object.keys(pkgJson.optionalDependencies ?? {});
    const peerDeps = Object.keys(pkgJson.peerDependencies ?? {});
    const optional = [...new Set([...optionalDeps, ...peerDeps])];
    const all = [...new Set([...required, ...optional])];
    return { required, optional, all };
  } catch {
    return EMPTY_DEPS;
  }
};

/**
 * Find a package in the pnpm store (.pnpm directory).
 * This is needed because pnpm doesn't hoist dependencies to root node_modules.
 */
const findInPnpmStore = (projectDir: string, pkgName: string): string | null => {
  const pnpmDir = path.join(projectDir, "node_modules", ".pnpm");
  if (!fsSync.existsSync(pnpmDir)) return null;

  // Convert package name to pnpm format: @scope/name -> @scope+name
  const pnpmPkgName = pkgName.replace("/", "+");

  try {
    const entries = fsSync.readdirSync(pnpmDir);
    for (const entry of entries) {
      // Match entries like "@smithy+config-resolver@3.0.0" or "lodash@4.17.21"
      if (entry.startsWith(pnpmPkgName + "@")) {
        const pkgPath = path.join(pnpmDir, entry, "node_modules", pkgName);
        if (fsSync.existsSync(pkgPath)) {
          try {
            return fsSync.realpathSync(pkgPath);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
};

export type CollectResult = {
  packages: Set<string>;
  resolvedPaths: Map<string, string>;
  warnings: string[];
};

/**
 * Recursively collect all packages including their declared dependencies.
 * This handles bundled packages (like those built with tsup) where
 * @vercel/nft can't trace statically due to external deps.
 *
 * Supports pnpm's isolated node_modules structure by looking for
 * nested dependencies in the package's own node_modules directory,
 * and falling back to searching the pnpm store.
 */
const collectTransitiveDeps = (
  projectDir: string,
  rootDeps: string[],
  searchPath: string = path.join(projectDir, "node_modules"),
  visited = new Set<string>(),
  resolvedPaths = new Map<string, string>(),
  warnings: string[] = [],
  /** Names of deps that are optional/peer — missing ones are silently skipped */
  optionalNames = new Set<string>()
): CollectResult => {
  const rootNodeModules = path.join(projectDir, "node_modules");

  for (const dep of rootDeps) {
    if (visited.has(dep)) continue;

    // Try to find the package in the current search path
    let pkgPath = path.join(searchPath, dep);
    let realPath: string | null = null;

    if (fsSync.existsSync(pkgPath)) {
      try {
        realPath = fsSync.realpathSync(pkgPath);
      } catch (err) {
        warnings.push(`realpathSync failed for "${dep}" at ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback to root node_modules (for npm/yarn hoisted deps)
    if (!realPath && searchPath !== rootNodeModules) {
      pkgPath = path.join(rootNodeModules, dep);
      if (fsSync.existsSync(pkgPath)) {
        try {
          realPath = fsSync.realpathSync(pkgPath);
        } catch (err) {
          warnings.push(`realpathSync failed for "${dep}" at ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Fallback to pnpm store search
    if (!realPath) {
      realPath = findInPnpmStore(projectDir, dep);
    }

    if (!realPath) {
      // Only warn for required deps; optional/peer deps that aren't installed are expected
      if (!optionalNames.has(dep)) {
        warnings.push(`Package "${dep}" not found (searched: ${searchPath}, root node_modules, pnpm store) — entire subtree skipped`);
      }
      continue;
    }

    visited.add(dep);
    resolvedPaths.set(dep, realPath);

    // Get this package's dependencies
    const pkgDeps = getPackageDeps(realPath);
    if (pkgDeps.all.length > 0) {
      // For pnpm, nested deps live in the same node_modules as the package itself
      // e.g., .pnpm/@aws-sdk+client-dynamodb@3.x.x/node_modules/@aws-sdk/client-dynamodb
      //       -> nested deps at .pnpm/@aws-sdk+client-dynamodb@3.x.x/node_modules/
      const isScoped = dep.startsWith("@");
      const pkgNodeModules = isScoped
        ? path.dirname(path.dirname(realPath))
        : path.dirname(realPath);

      const nextOptional = new Set(optionalNames);
      for (const name of pkgDeps.optional) nextOptional.add(name);

      collectTransitiveDeps(projectDir, pkgDeps.all, pkgNodeModules, visited, resolvedPaths, warnings, nextOptional);
    }
  }

  return { packages: visited, resolvedPaths, warnings };
};

/** AWS packages available in the Lambda runtime — excluded from layer */
const isAwsRuntime = (pkg: string) =>
  pkg.startsWith("@aws-sdk/") || pkg.startsWith("@smithy/");

export type CollectLayerResult = {
  packages: string[];
  resolvedPaths: Map<string, string>;
  warnings: string[];
};

/**
 * Collect all packages needed by production dependencies.
 * Uses package.json declarations recursively, then verifies completeness
 * and auto-adds any missing transitive deps as a safety net.
 */
export const collectLayerPackages = (projectDir: string, dependencies: string[]): CollectLayerResult => {
  if (dependencies.length === 0) return { packages: [], resolvedPaths: new Map(), warnings: [] };

  // Phase 1: collect all transitive deps from package.json declarations
  const { packages, resolvedPaths, warnings } = collectTransitiveDeps(projectDir, dependencies);

  // Phase 2: verify completeness — ensure all deps of included packages are also included
  // Check both Phase 1 resolved path and findPackagePath result, since pnpm may have
  // multiple versions of a package with different dependency sets.
  // Loop until no new packages are discovered (handles multi-level gaps)
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of [...packages]) {
      if (isAwsRuntime(pkg)) continue;

      // Collect all known locations for this package (may differ when multiple versions exist)
      const pkgPaths = new Set<string>();
      const resolved = resolvedPaths.get(pkg);
      if (resolved) pkgPaths.add(resolved);
      const found = findPackagePath(projectDir, pkg);
      if (found) pkgPaths.add(found);

      if (pkgPaths.size === 0) continue;

      for (const pkgPath of pkgPaths) {
        const pkgDeps = getPackageDeps(pkgPath);
        const optionalSet = new Set(pkgDeps.optional);
        for (const dep of pkgDeps.all) {
          if (!packages.has(dep) && !isAwsRuntime(dep)) {
            // Resolve the dep's path
            let depPath = findPackagePath(projectDir, dep);
            // Fallback: look in parent package's node_modules (pnpm nested structure)
            if (!depPath) {
              const isScoped = pkg.startsWith("@");
              const parentNodeModules = isScoped
                ? path.dirname(path.dirname(pkgPath))
                : path.dirname(pkgPath);
              const depInParent = path.join(parentNodeModules, dep);
              if (fsSync.existsSync(depInParent)) {
                try {
                  depPath = fsSync.realpathSync(depInParent);
                } catch {}
              }
            }

            // Skip optional/peer deps that aren't installed
            if (!depPath && optionalSet.has(dep)) continue;

            packages.add(dep);
            changed = true;
            if (depPath) resolvedPaths.set(dep, depPath);
          }
        }
      }
    }
  }

  return { packages: Array.from(packages), resolvedPaths, warnings };
};

/**
 * Find package path, checking both root node_modules and pnpm store
 */
const findPackagePath = (projectDir: string, pkgName: string): string | null => {
  // First try root node_modules
  const rootPath = getPackageRealPath(projectDir, pkgName);
  if (rootPath) return rootPath;

  // Fallback to pnpm store
  return findInPnpmStore(projectDir, pkgName);
};

export type CreateLayerZipResult = {
  buffer: Buffer;
  includedPackages: string[];
  skippedPackages: string[];
};

/**
 * Create layer zip with nodejs/node_modules structure.
 * Uses @vercel/nft traced packages.
 */
export const createLayerZip = (projectDir: string, packages: string[], resolvedPaths?: Map<string, string>) =>
  Effect.async<CreateLayerZipResult, Error>((resume) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    const addedPaths = new Set<string>();
    const includedPackages: string[] = [];
    const skippedPackages: string[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resume(Effect.succeed({
      buffer: Buffer.concat(chunks),
      includedPackages,
      skippedPackages
    })));
    archive.on("error", (err) => resume(Effect.fail(err)));

    for (const pkgName of packages) {
      const realPath = resolvedPaths?.get(pkgName) ?? findPackagePath(projectDir, pkgName);
      if (typeof realPath === "string" && realPath.length > 0 && !addedPaths.has(realPath)) {
        addedPaths.add(realPath);
        includedPackages.push(pkgName);
        archive.directory(realPath, `nodejs/node_modules/${pkgName}`, { date: FIXED_DATE });
      } else {
        skippedPackages.push(pkgName);
      }
    }

    archive.finalize();
  });

/**
 * Find existing layer version by hash in description
 */
export const getExistingLayerByHash = (layerName: string, expectedHash: string) =>
  Effect.gen(function* () {
    const versions = yield* lambda.make("list_layer_versions", {
      LayerName: layerName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed({ LayerVersions: [] })
      )
    );

    const matchingVersion = versions.LayerVersions?.find(v =>
      v.Description?.includes(`hash:${expectedHash}`)
    );

    if (!matchingVersion) {
      return null;
    }

    return {
      layerArn: matchingVersion.LayerVersionArn!,
      layerVersionArn: matchingVersion.LayerVersionArn!,
      version: matchingVersion.Version!,
      lockfileHash: expectedHash,
      status: "cached"
    } satisfies LayerResult;
  });

/**
 * Ensure layer exists with current dependencies.
 * Returns null if no production dependencies.
 */
export const ensureLayer = (config: LayerConfig) =>
  Effect.gen(function* () {
    const dependencies = yield* readProductionDependencies(config.projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );

    if (dependencies.length === 0) {
      yield* Effect.logDebug("No production dependencies, skipping layer creation");
      return null;
    }

    const hash = yield* computeLockfileHash(config.projectDir).pipe(
      Effect.catchAll((e) => {
        const message = e instanceof Error ? e.message : String(e);
        return Effect.logWarning(`Cannot compute lockfile hash: ${message}, skipping layer`).pipe(
          Effect.andThen(Effect.succeed(null))
        );
      })
    );

    if (!hash) {
      return null;
    }

    const layerName = `${config.project}-${config.stage}-deps`;

    // Check for existing layer with same hash
    const existing = yield* getExistingLayerByHash(layerName, hash);
    if (existing) {
      yield* Effect.logDebug(`Layer ${layerName} with hash ${hash} already exists (version ${existing.version})`);
      return existing;
    }

    // Collect all packages via transitive dep walking + completeness verification
    const { packages: allPackages, resolvedPaths, warnings: layerWarnings } = yield* Effect.sync(() => collectLayerPackages(config.projectDir, dependencies));

    // Surface all warnings so issues are visible, not silently swallowed
    for (const warning of layerWarnings) {
      yield* Effect.logWarning(`[layer] ${warning}`);
    }

    yield* Effect.logDebug(`Creating layer ${layerName} with ${allPackages.length} packages (hash: ${hash})`);
    yield* Effect.logDebug(`Layer packages: ${allPackages.join(", ")}`);

    // Create layer zip
    const { buffer: layerZip, includedPackages, skippedPackages } = yield* createLayerZip(config.projectDir, allPackages, resolvedPaths);

    if (skippedPackages.length > 0) {
      yield* Effect.logWarning(`Skipped ${skippedPackages.length} packages (not found): ${skippedPackages.slice(0, 10).join(", ")}${skippedPackages.length > 10 ? "..." : ""}`);
    }
    yield* Effect.logDebug(`Layer zip size: ${(layerZip.length / 1024 / 1024).toFixed(2)} MB (${includedPackages.length} packages)`);

    // Publish layer
    const result = yield* lambda.make("publish_layer_version", {
      LayerName: layerName,
      Description: `effortless deps layer hash:${hash}`,
      Content: { ZipFile: layerZip },
      CompatibleRuntimes: [Runtime.nodejs24x],
      CompatibleArchitectures: [Architecture.arm64]
    });

    yield* Effect.logDebug(`Published layer version ${result.Version}`);

    return {
      layerArn: result.LayerVersionArn!,
      layerVersionArn: result.LayerVersionArn!,
      version: result.Version!,
      lockfileHash: hash,
      status: "created"
    } satisfies LayerResult;
  });

/**
 * Delete a specific layer version
 */
export const deleteLayerVersion = (layerName: string, versionNumber: number) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting layer ${layerName} version ${versionNumber}`);

    yield* lambda.make("delete_layer_version", {
      LayerName: layerName,
      VersionNumber: versionNumber
    });
  });

export type LayerVersionInfo = {
  layerName: string;
  version: number;
  description: string | undefined;
  createdDate: string | undefined;
  arn: string;
};

/**
 * List all versions of a layer
 */
export const listLayerVersions = (layerName: string) =>
  Effect.gen(function* () {
    const result = yield* lambda.make("list_layer_versions", {
      LayerName: layerName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed({ LayerVersions: [] })
      )
    );

    return (result.LayerVersions ?? []).map(v => ({
      layerName,
      version: v.Version!,
      description: v.Description,
      createdDate: v.CreatedDate,
      arn: v.LayerVersionArn!
    } satisfies LayerVersionInfo));
  });

/**
 * Delete all versions of a layer
 */
export const deleteAllLayerVersions = (layerName: string) =>
  Effect.gen(function* () {
    const versions = yield* listLayerVersions(layerName);

    if (versions.length === 0) {
      yield* Effect.logDebug(`No versions found for layer ${layerName}`);
      return 0;
    }

    for (const v of versions) {
      yield* deleteLayerVersion(layerName, v.version);
    }

    return versions.length;
  });
