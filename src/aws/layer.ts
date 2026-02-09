import { Effect } from "effect";
import { Runtime } from "@aws-sdk/client-lambda";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import archiver from "archiver";
import { nodeFileTrace } from "@vercel/nft";
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

export type LayerResult = {
  layerArn: string;
  layerVersionArn: string;
  version: number;
  lockfileHash: string;
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
    const allPackages = collectTransitiveDeps(projectDir, prodDeps);

    // Build a sorted list of package@version pairs
    const packageVersions: string[] = [];
    for (const pkgName of Array.from(allPackages).sort()) {
      const pkgPath = findInPnpmStore(projectDir, pkgName)
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
 * Extract package name from a file path that's inside node_modules.
 * Handles both regular and scoped packages.
 * e.g., "/path/node_modules/@aws-sdk/client-dynamodb/dist/index.js" -> "@aws-sdk/client-dynamodb"
 * e.g., "/path/node_modules/effect/dist/index.js" -> "effect"
 */
const extractPackageName = (filePath: string): string | null => {
  const nodeModulesIndex = filePath.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return null;

  const afterNodeModules = filePath.slice(nodeModulesIndex + "node_modules/".length);
  const parts = afterNodeModules.split("/");

  const firstPart = parts[0];
  if (!firstPart) return null;

  if (firstPart.startsWith("@") && parts.length >= 2) {
    const secondPart = parts[1];
    if (!secondPart) return null;
    return `${firstPart}/${secondPart}`;
  }
  return firstPart;
};

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

/**
 * Find a valid JS entry point for a package.
 * Returns null if no entry point found (e.g., types-only packages).
 */
const findPackageEntryPoint = (depPath: string): string | null => {
  const pkgJsonPath = path.join(depPath, "package.json");
  if (!fsSync.existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(fsSync.readFileSync(pkgJsonPath, "utf-8"));

    // Try various entry point fields
    const candidates = [
      pkgJson.main,
      pkgJson.module,
      pkgJson.exports?.["."]?.require,
      pkgJson.exports?.["."]?.import,
      pkgJson.exports?.["."]?.default,
      typeof pkgJson.exports === "string" ? pkgJson.exports : null,
      "index.js",
      "index.cjs",
      "index.mjs"
    ].filter(Boolean);

    for (const candidate of candidates) {
      const entryPath = path.join(depPath, candidate);
      if (fsSync.existsSync(entryPath) && fsSync.statSync(entryPath).isFile()) {
        return entryPath;
      }
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Get all dependencies from a package's package.json (regular + optional + peer)
 */
const getPackageDeps = (pkgPath: string): string[] => {
  const pkgJsonPath = path.join(pkgPath, "package.json");
  if (!fsSync.existsSync(pkgJsonPath)) return [];

  try {
    const pkgJson = JSON.parse(fsSync.readFileSync(pkgJsonPath, "utf-8"));
    const deps = Object.keys(pkgJson.dependencies ?? {});
    const optionalDeps = Object.keys(pkgJson.optionalDependencies ?? {});
    const peerDeps = Object.keys(pkgJson.peerDependencies ?? {});
    return [...new Set([...deps, ...optionalDeps, ...peerDeps])];
  } catch {
    return [];
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
  visited = new Set<string>()
): Set<string> => {
  const rootNodeModules = path.join(projectDir, "node_modules");

  for (const dep of rootDeps) {
    if (visited.has(dep)) continue;

    // Try to find the package in the current search path
    let pkgPath = path.join(searchPath, dep);
    let realPath: string | null = null;

    if (fsSync.existsSync(pkgPath)) {
      try {
        realPath = fsSync.realpathSync(pkgPath);
      } catch {
        // ignore
      }
    }

    // Fallback to root node_modules (for npm/yarn hoisted deps)
    if (!realPath && searchPath !== rootNodeModules) {
      pkgPath = path.join(rootNodeModules, dep);
      if (fsSync.existsSync(pkgPath)) {
        try {
          realPath = fsSync.realpathSync(pkgPath);
        } catch {
          // ignore
        }
      }
    }

    // Fallback to pnpm store search
    if (!realPath) {
      realPath = findInPnpmStore(projectDir, dep);
    }

    if (!realPath) continue;

    visited.add(dep);

    // Get this package's dependencies
    const pkgDeps = getPackageDeps(realPath);
    if (pkgDeps.length > 0) {
      // For pnpm, nested deps live in the same node_modules as the package itself
      // e.g., .pnpm/@aws-sdk+client-dynamodb@3.x.x/node_modules/@aws-sdk/client-dynamodb
      //       -> nested deps at .pnpm/@aws-sdk+client-dynamodb@3.x.x/node_modules/
      const isScoped = dep.startsWith("@");
      const pkgNodeModules = isScoped
        ? path.dirname(path.dirname(realPath))
        : path.dirname(realPath);

      collectTransitiveDeps(projectDir, pkgDeps, pkgNodeModules, visited);
    }
  }

  return visited;
};

/**
 * Use @vercel/nft to trace all packages needed by production dependencies.
 * Also includes declared dependencies from package.json for bundled packages.
 * Returns a list of package names that should be included in the layer.
 */
export const collectLayerPackages = async (projectDir: string, dependencies: string[]): Promise<string[]> => {
  if (dependencies.length === 0) return [];

  // First, collect all transitive deps from package.json declarations
  // This catches deps that can't be traced statically (e.g., bundled packages)
  const packages = collectTransitiveDeps(projectDir, dependencies);

  // Also trace with @vercel/nft to catch dynamic imports and such
  const entryPoints: string[] = [];
  for (const dep of dependencies) {
    const pkgPath = path.join(projectDir, "node_modules", dep);
    if (fsSync.existsSync(pkgPath)) {
      const entryPoint = findPackageEntryPoint(pkgPath);
      if (entryPoint) {
        entryPoints.push(entryPoint);
      }
    }
  }

  if (entryPoints.length > 0) {
    try {
      const { fileList } = await nodeFileTrace(entryPoints, {
        base: projectDir
      });

      for (const file of fileList) {
        const pkgName = extractPackageName(path.join(projectDir, file));
        if (pkgName) {
          packages.add(pkgName);
        }
      }
    } catch {
      // If nft fails, we still have the declared deps
    }
  }

  return Array.from(packages);
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
export const createLayerZip = (projectDir: string, packages: string[]) =>
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
      const realPath = findPackagePath(projectDir, pkgName);
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
      lockfileHash: expectedHash
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
      yield* Effect.logInfo("No production dependencies, skipping layer creation");
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
      yield* Effect.logInfo(`Layer ${layerName} with hash ${hash} already exists (version ${existing.version})`);
      return existing;
    }

    // Collect all packages using @vercel/nft
    const allPackages = yield* Effect.promise(() => collectLayerPackages(config.projectDir, dependencies));
    yield* Effect.logInfo(`Creating layer ${layerName} with ${allPackages.length} packages (hash: ${hash})`);
    yield* Effect.logDebug(`Layer packages: ${allPackages.join(", ")}`);

    // Create layer zip
    const { buffer: layerZip, includedPackages, skippedPackages } = yield* createLayerZip(config.projectDir, allPackages);

    if (skippedPackages.length > 0) {
      yield* Effect.logWarning(`Skipped ${skippedPackages.length} packages (not found): ${skippedPackages.slice(0, 10).join(", ")}${skippedPackages.length > 10 ? "..." : ""}`);
    }
    yield* Effect.logInfo(`Layer zip size: ${(layerZip.length / 1024 / 1024).toFixed(2)} MB (${includedPackages.length} packages)`);

    // Publish layer
    const result = yield* lambda.make("publish_layer_version", {
      LayerName: layerName,
      Description: `effortless deps layer hash:${hash}`,
      Content: { ZipFile: layerZip },
      CompatibleRuntimes: [Runtime.nodejs22x]
    });

    yield* Effect.logInfo(`Published layer version ${result.Version}`);

    return {
      layerArn: result.LayerVersionArn!,
      layerVersionArn: result.LayerVersionArn!,
      version: result.Version!,
      lockfileHash: hash
    } satisfies LayerResult;
  });

/**
 * Delete a specific layer version
 */
export const deleteLayerVersion = (layerName: string, versionNumber: number) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Deleting layer ${layerName} version ${versionNumber}`);

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
      yield* Effect.logInfo(`No versions found for layer ${layerName}`);
      return 0;
    }

    for (const v of versions) {
      yield* deleteLayerVersion(layerName, v.version);
    }

    return versions.length;
  });
