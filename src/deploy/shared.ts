import { Effect } from "effect";
import * as fs from "fs/promises";
import * as path from "path";
import {
  ensureRole,
  ensureLambda,
  makeTags,
  resolveStage,
  type TagContext,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages
} from "../aws";
import { bundle, zip, type BundleInput } from "~/build/bundle";

// ============ Common types ============

export type DeployResult = {
  exportName: string;
  url: string;
  functionArn: string;
};

export type DeployTableResult = {
  exportName: string;
  functionArn: string;
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
  projectDir: string;
}) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.projectDir
    });

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.projectDir)
      : [];
    const external = prodDeps.length > 0
      ? yield* Effect.promise(() => collectLayerPackages(input.projectDir, prodDeps))
      : [];

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
  bundleType?: "http" | "table";
  layerArn?: string;
  external?: string[];
  /** Environment variables to set on the Lambda (e.g., for deps) */
  depsEnv?: Record<string, string>;
  /** Additional IAM permissions for deps access */
  depsPermissions?: readonly string[];
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
  depsPermissions
}: DeployCoreLambdaInput) =>
  Effect.gen(function* () {
    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName
    };

    yield* Effect.logInfo(`Deploying Lambda: ${handlerName}`);

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

    const bundled = yield* bundle({
      ...input,
      exportName,
      ...(bundleType ? { type: bundleType } : {}),
      ...(external && external.length > 0 ? { external } : {})
    });
    const code = yield* zip({ content: bundled });

    const environment: Record<string, string> = {
      EFF_PROJECT: input.project,
      EFF_STAGE: tagCtx.stage,
      EFF_HANDLER: handlerName,
      ...depsEnv
    };

    const functionArn = yield* ensureLambda({
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

    return { functionArn, tagCtx };
  });
