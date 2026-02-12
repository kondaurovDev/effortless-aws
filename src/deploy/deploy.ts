import { Effect } from "effect";
import * as path from "path";
import {
  Aws,
  ensureProjectApi,
  addRouteToApi,
  ensureTable,
  makeTags,
  resolveStage,
  type TagContext,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages
} from "../aws";
import { findHandlerFiles, discoverHandlers, type DiscoveredHandlers } from "~/build/bundle";
import type { ParamEntry } from "~/build/handler-registry";

// Re-export from shared
export {
  type DeployResult,
  type DeployTableResult,
  type DeployAllResult,
  type DeployInput
} from "./shared";

// Re-export from deploy-http
export { deploy, deployAll } from "./deploy-http";

// Re-export from deploy-table
export { deployTable, deployAllTables } from "./deploy-table";

// Import for internal use
import { type DeployInput, type DeployResult, type DeployTableResult } from "./shared";
import { deployLambda } from "./deploy-http";
import { deployTableFunction } from "./deploy-table";
import { deploySiteLambda } from "./deploy-site";

// ============ Layer preparation ============

type PrepareLayerInput = {
  project: string;
  stage: string;
  region: string;
  projectDir: string;
};

const prepareLayer = (input: PrepareLayerInput) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.projectDir
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region: input.region }
        })
      )
    );

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.projectDir)
      : [];
    const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(input.projectDir, prodDeps))
      : { packages: [] as string[], warnings: [] as string[] };

    for (const warning of layerWarnings) {
      yield* Effect.logWarning(`[layer] ${warning}`);
    }

    yield* Effect.logDebug(`Layer result: ${layerResult ? "exists" : "null"}, external packages: ${external.length}`);
    if (external.length > 0) {
      yield* Effect.logInfo(`Bundling with ${external.length} external packages from layer`);
    }

    return {
      layerArn: layerResult?.layerVersionArn,
      external
    };
  });

// ============ Deps resolution ============

const TABLE_CLIENT_PERMISSIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:DeleteItem",
  "dynamodb:Query",
  "dynamodb:Scan",
  "dynamodb:UpdateItem",
  "dynamodb:BatchGetItem",
  "dynamodb:BatchWriteItem",
] as const;

/**
 * Build a map of all table handler export names to their resolved DynamoDB table names.
 * Table names are deterministic: ${project}-${stage}-${handlerName}
 */
const buildTableNameMap = (
  tableHandlers: DiscoveredHandlers["tableHandlers"],
  project: string,
  stage: string
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of tableHandlers) {
    for (const fn of exports) {
      const handlerName = fn.config.name ?? fn.exportName;
      map.set(fn.exportName, `${project}-${stage}-${handlerName}`);
    }
  }
  return map;
};

/**
 * Resolve deps keys to environment variables and IAM permissions.
 */
const resolveDeps = (
  depsKeys: string[],
  tableNameMap: Map<string, string>
): { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined => {
  if (depsKeys.length === 0) return undefined;

  const depsEnv: Record<string, string> = {};
  for (const key of depsKeys) {
    const tableName = tableNameMap.get(key);
    if (tableName) {
      depsEnv[`EFF_TABLE_${key}`] = tableName;
    }
  }

  if (Object.keys(depsEnv).length === 0) return undefined;

  return { depsEnv, depsPermissions: TABLE_CLIENT_PERMISSIONS };
};

// ============ Params resolution ============

const SSM_PERMISSIONS = [
  "ssm:GetParameter",
  "ssm:GetParameters",
] as const;

/**
 * Resolve param entries to environment variables and IAM permissions.
 * SSM path convention: /${project}/${stage}/${key}
 */
const resolveParams = (
  paramEntries: ParamEntry[],
  project: string,
  stage: string
): { paramsEnv: Record<string, string>; paramsPermissions: readonly string[] } | undefined => {
  if (paramEntries.length === 0) return undefined;

  const paramsEnv: Record<string, string> = {};
  for (const { propName, ssmKey } of paramEntries) {
    paramsEnv[`EFF_PARAM_${propName}`] = `/${project}/${stage}/${ssmKey}`;
  }

  return { paramsEnv, paramsPermissions: SSM_PERMISSIONS };
};

/**
 * Merge deps and params resolution into a single env/permissions payload.
 */
const mergeResolved = (
  deps: { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined,
  params: { paramsEnv: Record<string, string>; paramsPermissions: readonly string[] } | undefined
): { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined => {
  if (!deps && !params) return undefined;

  const env = { ...deps?.depsEnv, ...params?.paramsEnv };
  const permissions = [...(deps?.depsPermissions ?? []), ...(params?.paramsPermissions ?? [])];

  if (Object.keys(env).length === 0) return undefined;

  return { depsEnv: env, depsPermissions: permissions };
};

// ============ Platform table ============

const PLATFORM_PERMISSIONS = [
  "dynamodb:PutItem",
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
  "dynamodb:Query",
] as const;

const ensurePlatformTable = (project: string, stage: string, region: string) =>
  Effect.gen(function* () {
    const tableName = `${project}-${stage}-platform`;
    const tagCtx: TagContext = { project, stage, handler: "platform" };

    yield* Effect.logInfo(`Ensuring platform table: ${tableName}`);

    yield* ensureTable({
      name: tableName,
      pk: { name: "pk", type: "string" },
      sk: { name: "sk", type: "string" },
      billingMode: "PAY_PER_REQUEST",
      streamView: "NEW_AND_OLD_IMAGES",
      tags: makeTags(tagCtx, "dynamodb"),
      ttlAttribute: "ttl",
    }).pipe(
      Effect.provide(
        Aws.makeClients({ dynamodb: { region } })
      )
    );

    return tableName;
  });

// ============ HTTP handlers deployment ============

type DeployHttpHandlersInput = {
  handlers: DiscoveredHandlers["httpHandlers"];
  apiId: string;
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
  tableNameMap: Map<string, string>;
  platformEnv: Record<string, string>;
  platformPermissions: readonly string[];
};

const deployHttpHandlers = (ctx: DeployHttpHandlersInput) =>
  Effect.gen(function* () {
    const results: DeployResult[] = [];

    for (const { file, exports } of ctx.handlers) {
      yield* Effect.logInfo(`Processing ${path.basename(file)} (${exports.length} HTTP handler(s))`);

      const deployInput: DeployInput = {
        projectDir: ctx.input.projectDir,
        file,
        project: ctx.input.project,
        region: ctx.input.region
      };
      if (ctx.input.stage) deployInput.stage = ctx.input.stage;

      for (const fn of exports) {
        const stage = resolveStage(ctx.input.stage);
        const resolved = mergeResolved(
          resolveDeps(fn.depsKeys, ctx.tableNameMap),
          resolveParams(fn.paramEntries, ctx.input.project, stage)
        );
        const withPlatform = {
          depsEnv: { ...resolved?.depsEnv, ...ctx.platformEnv },
          depsPermissions: [...(resolved?.depsPermissions ?? []), ...ctx.platformPermissions],
        };
        const { exportName, functionArn, config } = yield* deployLambda({
          input: deployInput,
          fn,
          ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
          ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
          depsEnv: withPlatform.depsEnv,
          depsPermissions: withPlatform.depsPermissions,
          ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              iam: { region: ctx.input.region }
            })
          )
        );

        const { apiUrl: handlerUrl } = yield* addRouteToApi({
          apiId: ctx.apiId,
          region: ctx.input.region,
          functionArn,
          method: config.method,
          path: config.path
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              apigatewayv2: { region: ctx.input.region }
            })
          )
        );

        results.push({ exportName, url: handlerUrl, functionArn });
        yield* Effect.logInfo(`  ${config.method} ${config.path} → ${config.name}`);
      }
    }

    return results;
  });

// ============ Table handlers deployment ============

type DeployTableHandlersInput = {
  handlers: DiscoveredHandlers["tableHandlers"];
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
  tableNameMap: Map<string, string>;
  platformEnv: Record<string, string>;
  platformPermissions: readonly string[];
};

const deployTableHandlers = (ctx: DeployTableHandlersInput) =>
  Effect.gen(function* () {
    const results: DeployTableResult[] = [];

    for (const { file, exports } of ctx.handlers) {
      yield* Effect.logInfo(`Processing ${path.basename(file)} (${exports.length} table handler(s))`);

      const deployInput: DeployInput = {
        projectDir: ctx.input.projectDir,
        file,
        project: ctx.input.project,
        region: ctx.input.region
      };
      if (ctx.input.stage) deployInput.stage = ctx.input.stage;

      for (const fn of exports) {
        const stage = resolveStage(ctx.input.stage);
        const resolved = mergeResolved(
          resolveDeps(fn.depsKeys, ctx.tableNameMap),
          resolveParams(fn.paramEntries, ctx.input.project, stage)
        );
        const withPlatform = {
          depsEnv: { ...resolved?.depsEnv, ...ctx.platformEnv },
          depsPermissions: [...(resolved?.depsPermissions ?? []), ...ctx.platformPermissions],
        };
        const result = yield* deployTableFunction({
          input: deployInput,
          fn,
          ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
          ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
          depsEnv: withPlatform.depsEnv,
          depsPermissions: withPlatform.depsPermissions,
          ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              iam: { region: ctx.input.region },
              dynamodb: { region: ctx.input.region }
            })
          )
        );
        results.push(result);
      }
    }

    return results;
  });

// ============ Site handlers deployment ============

type DeploySiteHandlersInput = {
  handlers: DiscoveredHandlers["siteHandlers"];
  apiId: string;
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
  platformEnv: Record<string, string>;
  platformPermissions: readonly string[];
};

const deploySiteHandlers = (ctx: DeploySiteHandlersInput) =>
  Effect.gen(function* () {
    const results: DeployResult[] = [];

    for (const { file, exports } of ctx.handlers) {
      yield* Effect.logInfo(`Processing ${path.basename(file)} (${exports.length} site handler(s))`);

      const deployInput: DeployInput = {
        projectDir: ctx.input.projectDir,
        file,
        project: ctx.input.project,
        region: ctx.input.region
      };
      if (ctx.input.stage) deployInput.stage = ctx.input.stage;

      for (const fn of exports) {
        const withPlatform = {
          depsEnv: { ...ctx.platformEnv },
          depsPermissions: [...ctx.platformPermissions],
        };
        const { exportName, functionArn, config, handlerName } = yield* deploySiteLambda({
          input: deployInput,
          fn,
          ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
          ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
          depsEnv: withPlatform.depsEnv,
          depsPermissions: withPlatform.depsPermissions,
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              iam: { region: ctx.input.region }
            })
          )
        );

        // Strip trailing slash from base path
        const basePath = config.path.replace(/\/+$/, "") || "/";

        // Route 1: root path (serves index.html)
        const { apiUrl: rootUrl } = yield* addRouteToApi({
          apiId: ctx.apiId,
          region: ctx.input.region,
          functionArn,
          method: "GET",
          path: basePath
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              apigatewayv2: { region: ctx.input.region }
            })
          )
        );

        // Route 2: greedy subpath (serves all files)
        yield* addRouteToApi({
          apiId: ctx.apiId,
          region: ctx.input.region,
          functionArn,
          method: "GET",
          path: `${basePath}/{file+}`
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              apigatewayv2: { region: ctx.input.region }
            })
          )
        );

        results.push({ exportName, url: rootUrl, functionArn });
        yield* Effect.logInfo(`  GET ${basePath} → ${handlerName} (site)`);
      }
    }

    return results;
  });

// ============ Project deployment ============

export type DeployProjectInput = {
  projectDir: string;
  patterns: string[];
  project: string;
  stage?: string;
  region: string;
};

export type DeployProjectResult = {
  apiId?: string;
  apiUrl?: string;
  httpResults: DeployResult[];
  tableResults: DeployTableResult[];
  siteResults: DeployResult[];
};

export const deployProject = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    // Discover handlers from file patterns
    const files = findHandlerFiles(input.patterns, input.projectDir);

    if (files.length === 0) {
      return yield* Effect.fail(new Error(`No files match patterns: ${input.patterns.join(", ")}`));
    }

    yield* Effect.logInfo(`Found ${files.length} file(s) matching patterns`);

    const { httpHandlers, tableHandlers, siteHandlers } = discoverHandlers(files);

    const totalHttpHandlers = httpHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalTableHandlers = tableHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalSiteHandlers = siteHandlers.reduce((acc, h) => acc + h.exports.length, 0);

    if (totalHttpHandlers === 0 && totalTableHandlers === 0 && totalSiteHandlers === 0) {
      return yield* Effect.fail(new Error("No handlers found in matched files"));
    }

    yield* Effect.logInfo(`Discovered ${totalHttpHandlers} HTTP, ${totalTableHandlers} table, ${totalSiteHandlers} site handler(s)`);

    // Build table name map for deps resolution
    const tableNameMap = buildTableNameMap(tableHandlers, input.project, resolveStage(input.stage));

    // Prepare layer
    const { layerArn, external } = yield* prepareLayer({
      project: input.project,
      stage: resolveStage(input.stage),
      region: input.region,
      projectDir: input.projectDir
    });

    // Ensure platform table
    const stage = resolveStage(input.stage);
    const platformTableName = yield* ensurePlatformTable(input.project, stage, input.region);
    const platformEnv = { EFF_PLATFORM_TABLE: platformTableName };

    // Setup API Gateway for HTTP handlers
    let apiId: string | undefined;
    let apiUrl: string | undefined;

    if (totalHttpHandlers > 0 || totalSiteHandlers > 0) {
      const tagCtx: TagContext = {
        project: input.project,
        stage: resolveStage(input.stage),
        handler: "api"
      };

      yield* Effect.logInfo("Setting up API Gateway...");
      const api = yield* ensureProjectApi({
        projectName: input.project,
        stage: tagCtx.stage,
        region: input.region,
        tags: makeTags(tagCtx, "api-gateway")
      }).pipe(
        Effect.provide(
          Aws.makeClients({
            apigatewayv2: { region: input.region }
          })
        )
      );

      apiId = api.apiId;
      apiUrl = `https://${apiId}.execute-api.${input.region}.amazonaws.com`;
    }

    // Deploy handlers
    const httpResults = apiId
      ? yield* deployHttpHandlers({
          handlers: httpHandlers,
          apiId,
          input,
          layerArn,
          external,
          tableNameMap,
          platformEnv,
          platformPermissions: PLATFORM_PERMISSIONS,
        })
      : [];

    const tableResults = yield* deployTableHandlers({
      handlers: tableHandlers,
      input,
      layerArn,
      external,
      tableNameMap,
      platformEnv,
      platformPermissions: PLATFORM_PERMISSIONS,
    });

    const siteResults = apiId
      ? yield* deploySiteHandlers({
          handlers: siteHandlers,
          apiId,
          input,
          layerArn,
          external,
          platformEnv,
          platformPermissions: PLATFORM_PERMISSIONS,
        })
      : [];

    if (apiUrl) {
      yield* Effect.logInfo(`Deployment complete! API: ${apiUrl}`);
    }

    return { apiId, apiUrl, httpResults, tableResults, siteResults };
  });
