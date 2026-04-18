import { Effect } from "effect";
import { Path, FileSystem } from "@effect/platform";
import { ensureRole, ensureLambda, type LambdaStatus, ensureLayer } from "../aws";
import { readProductionDependencies, collectLayerPackages, findDepsDir } from "../build";
import { makeTags, type TagContext } from "../core";
import { DeployContext } from "../core";
import { bundle, zip, resolveStaticFiles, type BundleInput } from "~/build/bundle";
import * as path from "path";

// ============ Deferred warnings ============

let _deferredWarnings: string[] = [];

/** Collect a warning to be shown after the progress spinner finishes. */
export const deferWarning = (message: string) =>
  Effect.sync(() => { _deferredWarnings.push(message); });

/** Flush and return all deferred warnings, resetting the buffer. */
export const flushDeferredWarnings = (): string[] => {
  const warnings = _deferredWarnings;
  _deferredWarnings = [];
  return warnings;
};

// ============ Bundle collector ============

let _bundleCollector: Map<string, string> | undefined;

/** Start collecting handler bundle code during deploy. */
export const startBundleCollector = () => { _bundleCollector = new Map(); };

/** Store a bundle in the collector (no-op if collector not started). */
export const collectBundle = (name: string, code: string) => {
  if (_bundleCollector) _bundleCollector.set(name, code);
};

/** Flush and return all collected bundles, resetting the collector. */
export const flushBundleCollector = (): Map<string, string> => {
  const bundles = _bundleCollector ?? new Map();
  _bundleCollector = undefined;
  return bundles;
};

// ============ Deploy log collector ============

let _deployLog: string[] | undefined;

/** Start collecting deploy log lines. */
export const startDeployLog = () => { _deployLog = []; };

/** Append a line to the deploy log (no-op if collector not started). */
export const logDeploy = (message: string) => {
  if (_deployLog) {
    _deployLog.push(`${new Date().toISOString()} ${message}`);
  }
};

/** Flush and return all collected log lines, resetting the collector. */
export const flushDeployLog = (): string[] => {
  const lines = _deployLog ?? [];
  _deployLog = undefined;
  return lines;
};

// ============ Common types ============

export type DeployResult = {
  exportName: string;
  url: string;
  functionArn: string;
  bundleSize?: number;
};

export type DeployTableResult = {
  exportName: string;
  functionArn?: string;
  status: LambdaStatus;
  bundleSize?: number;
  tableArn: string;
  streamArn?: string;
};

export type DeployAllResult = {
  apiId: string;
  apiUrl: string;
  handlers: DeployResult[];
};

export type DeployInput = BundleInput & {
  exportName?: string;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  return `${(kb / 1024).toFixed(2)}MB`;
};

// ============ Secret resolution ============

import type { SecretEntry } from "~/core";

const SSM_PERMISSIONS = [
  "ssm:GetParameter",
  "ssm:GetParameters",
] as const;

/**
 * Resolve secret entries into EFF_PARAM_* environment variables and SSM permissions.
 * Used by both full-project deploy and single-handler deploy.
 */
export const resolveSecrets = (
  secretEntries: SecretEntry[],
  project: string,
  stage: string
): { paramsEnv: Record<string, string>; paramsPermissions: readonly string[] } | undefined => {
  if (secretEntries.length === 0) return undefined;

  const paramsEnv: Record<string, string> = {};
  for (const { propName, ssmKey } of secretEntries) {
    paramsEnv[`EFF_PARAM_${propName}`] = `/${project}/${stage}/${ssmKey}`;
  }

  return { paramsEnv, paramsPermissions: [...SSM_PERMISSIONS] };
};

// ============ Shared utilities ============

export const readSource = (input: DeployInput) =>
  Effect.gen(function* () {
    if ("code" in input && typeof input.code === "string") {
      return input.code;
    }
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const filePath = p.isAbsolute(input.file)
      ? input.file
      : p.join(input.projectDir, input.file);
    return yield* fs.readFileString(filePath);
  });

export type LayerInfo = {
  layerArn: string | undefined;
  external: string[];
};

export const ensureLayerAndExternal = (input: {
  projectDir: string;
  /** Handler file path — used to find the correct package.json in monorepos */
  file?: string;
}) =>
  Effect.gen(function* () {
    const { project, stage, region } = yield* DeployContext;
    const depsDir = input.file
      ? findDepsDir(path.dirname(path.resolve(input.projectDir, input.file)), input.projectDir)
      : input.projectDir;

    const layerResult = yield* ensureLayer({
      projectDir: depsDir,
    });

    const prodDeps = layerResult
      ? yield* readProductionDependencies(depsDir)
      : [];
    const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(depsDir, prodDeps))
      : { packages: [] as string[], warnings: [] as string[] };

    for (const warning of layerWarnings) {
      yield* deferWarning(`[layer] ${warning}`);
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
  bundleType?: "table" | "app" | "fifoQueue" | "bucket" | "api" | "cron" | "mcp";
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
    const { project, stage, region } = yield* DeployContext;

    const tagCtx: TagContext = {
      project,
      stage,
      handler: handlerName
    };

    yield* Effect.logDebug(`Deploying Lambda: ${handlerName}`);
    logDeploy(`[${bundleType ?? "lambda"}] ${handlerName}: starting deploy`);

    if (external && external.length > 0) {
      yield* Effect.logDebug(`Using ${external.length} external packages: ${external.join(", ")}`);
      logDeploy(`[${bundleType ?? "lambda"}] ${handlerName}: ${external.length} external packages`);
    }

    const mergedPermissions = [
      ...(defaultPermissions ?? []),
      ...(permissions ?? []),
      ...(depsPermissions ?? [])
    ];

    const roleArn = yield* ensureRole(
      project,
      stage,
      handlerName,
      mergedPermissions.length > 0 ? mergedPermissions : undefined,
      makeTags(tagCtx)
    );

    const bundleResult = yield* bundle({
      ...input,
      exportName,
      ...(bundleType ? { type: bundleType } : {}),
      ...(external && external.length > 0 ? { external } : {})
    });
    let staticFiles: import("../build/bundle").StaticFile[] | undefined;
    if (staticGlobs && staticGlobs.length > 0) {
      const resolved = yield* resolveStaticFiles(staticGlobs, input.projectDir);
      if (resolved.missing.length > 0) {
        yield* deferWarning(`Static files not found for "${handlerName}": ${resolved.missing.join(", ")}`);
      }
      staticFiles = resolved.files.length > 0 ? resolved.files : undefined;
    }
    const bundleSize = Buffer.byteLength(bundleResult.code, "utf-8");

    // Log bundle composition when size exceeds 500KB
    if (bundleResult.topModules && bundleSize > 500 * 1024) {
      const top = bundleResult.topModules.slice(0, 10);
      const lines = top.map(m => `  ${formatBytes(m.bytes).padStart(8)}  ${m.path}`).join("\n");
      yield* deferWarning(`Bundle "${handlerName}" is ${formatBytes(bundleSize)} — top modules:\n${lines}`);
    }

    const code = yield* zip({ content: bundleResult.code, staticFiles });

    const environment: Record<string, string> = {
      EFF_PROJECT: project,
      EFF_STAGE: stage,
      EFF_HANDLER: handlerName,
      ...depsEnv
    };

    const { functionArn, status } = yield* ensureLambda({
      name: handlerName,
      roleArn,
      code,
      memory,
      timeout,
      tags: makeTags(tagCtx),
      ...(layerArn ? { layers: [layerArn] } : {}),
      environment
    });

    collectBundle(handlerName, bundleResult.code);

    logDeploy(`[${bundleType ?? "lambda"}] ${handlerName}: ${status} (${formatBytes(bundleSize)})`);

    return { functionArn, status, tagCtx, bundleSize };
  });
