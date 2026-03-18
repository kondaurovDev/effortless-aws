import { Effect } from "effect";
import * as fs from "fs/promises";
import * as path from "path";
import {
  ensureRole,
  ensureLambda,
  type LambdaStatus,
  makeTags,
  resolveStage,
  type TagContext,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages
} from "../aws";
import { bundle, zip, resolveStaticFiles, type BundleInput } from "~/build/bundle";

// ============ Common types ============

export type DeployResult = {
  exportName: string;
  url: string;
  functionArn: string;
  bundleSize?: number;
};

export type DeployTableResult = {
  exportName: string;
  functionArn: string;
  status: LambdaStatus;
  bundleSize?: number;
  tableArn: string;
  streamArn: string;
};

export type DeployAllResult = {
  apiId: string;
  apiUrl: string;
  handlers: DeployResult[];
};

export type DeployInput = BundleInput & {
  project: string;
  stage?: string;
  region: string;
  exportName?: string;
  /** Directory with package.json and node_modules (= cwd). Falls back to projectDir. */
  packageDir?: string;
  extraNodeModules?: string[];
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  return `${(kb / 1024).toFixed(2)}MB`;
};

// ============ Shared utilities ============

export const readSource = (input: DeployInput): Effect.Effect<string> =>
  Effect.gen(function* () {
    if ("code" in input && typeof input.code === "string") {
      return input.code;
    }
    const filePath = path.isAbsolute(input.file)
      ? input.file
      : path.join(input.projectDir, input.file);
    return yield* Effect.promise(() => fs.readFile(filePath, "utf-8"));
  });

export type LayerInfo = {
  layerArn: string | undefined;
  external: string[];
};

export const ensureLayerAndExternal = (input: {
  project: string;
  stage: string;
  region: string;
  /** Directory with package.json and node_modules (may differ from projectDir when root is set) */
  packageDir: string;
  extraNodeModules?: string[];
}) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.packageDir,
      extraNodeModules: input.extraNodeModules
    });

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.packageDir)
      : [];
    const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(input.packageDir, prodDeps, input.extraNodeModules))
      : { packages: [] as string[], warnings: [] as string[] };

    for (const warning of layerWarnings) {
      yield* Effect.logWarning(`[layer] ${warning}`);
    }

    return {
      layerArn: layerResult?.layerVersionArn,
      external
    };
  });

// ============ Core Lambda deployment ============

export type DeployCoreLambdaInput = {
  input: DeployInput;
  exportName: string;
  handlerName: string;
  permissions?: readonly string[];
  defaultPermissions?: readonly string[];
  memory?: number;
  timeout?: number;
  bundleType?: "table" | "app" | "fifoQueue" | "bucket" | "api";
  layerArn?: string;
  external?: string[];
  /** Environment variables to set on the Lambda (e.g., for deps) */
  depsEnv?: Record<string, string>;
  /** Additional IAM permissions for deps access */
  depsPermissions?: readonly string[];
  /** Static file glob patterns to bundle into the Lambda ZIP */
  staticGlobs?: string[];
};

export const deployCoreLambda = ({
  input,
  exportName,
  handlerName,
  permissions,
  defaultPermissions,
  memory = 256,
  timeout = 30,
  bundleType,
  layerArn,
  external,
  depsEnv,
  depsPermissions,
  staticGlobs
}: DeployCoreLambdaInput) =>
  Effect.gen(function* () {
    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName
    };

    yield* Effect.logDebug(`Deploying Lambda: ${handlerName}`);

    if (external && external.length > 0) {
      yield* Effect.logDebug(`Using ${external.length} external packages: ${external.join(", ")}`);
    }

    const mergedPermissions = [
      ...(defaultPermissions ?? []),
      ...(permissions ?? []),
      ...(depsPermissions ?? [])
    ];

    const roleArn = yield* ensureRole(
      input.project,
      tagCtx.stage,
      handlerName,
      mergedPermissions.length > 0 ? mergedPermissions : undefined,
      makeTags(tagCtx, "iam-role")
    );

    const bundleResult = yield* bundle({
      ...input,
      exportName,
      ...(bundleType ? { type: bundleType } : {}),
      ...(external && external.length > 0 ? { external } : {})
    });
    let staticFiles: import("../build/bundle").StaticFile[] | undefined;
    if (staticGlobs && staticGlobs.length > 0) {
      const resolved = resolveStaticFiles(staticGlobs, input.projectDir);
      if (resolved.missing.length > 0) {
        yield* Effect.logWarning(`Static files not found for "${handlerName}": ${resolved.missing.join(", ")}`);
      }
      staticFiles = resolved.files.length > 0 ? resolved.files : undefined;
    }
    const bundleSize = Buffer.byteLength(bundleResult.code, "utf-8");

    // Log bundle composition when size exceeds 500KB
    if (bundleResult.topModules && bundleSize > 500 * 1024) {
      const top = bundleResult.topModules.slice(0, 10);
      const lines = top.map(m => `  ${formatBytes(m.bytes).padStart(8)}  ${m.path}`).join("\n");
      yield* Effect.logWarning(`Bundle "${handlerName}" is ${formatBytes(bundleSize)} — top modules:\n${lines}`);
    }

    const code = yield* zip({ content: bundleResult.code, staticFiles });

    const environment: Record<string, string> = {
      EFF_PROJECT: input.project,
      EFF_STAGE: tagCtx.stage,
      EFF_HANDLER: handlerName,
      ...depsEnv
    };

    const { functionArn, status } = yield* ensureLambda({
      project: input.project,
      stage: tagCtx.stage,
      name: handlerName,
      region: input.region,
      roleArn,
      code,
      memory,
      timeout,
      tags: makeTags(tagCtx, "lambda"),
      ...(layerArn ? { layers: [layerArn] } : {}),
      environment
    });

    return { functionArn, status, tagCtx, bundleSize };
  });
