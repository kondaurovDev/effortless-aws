import { Effect, Console } from "effect";
import { c } from "~/cli/colors";
import {
  Aws,
  makeTags,
  resolveStage,
  type TagContext,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages,
  cleanupOrphanedFunctions,
  ensureFunctionUrl,
  addFunctionUrlPublicAccess,
} from "../aws";
import { findHandlerFiles, discoverHandlers, type DiscoveredHandlers } from "~/build/bundle";
import type { ParamEntry } from "~/build/handler-registry";
import { collectRequiredParams, checkMissingParams } from "./resolve-config";

// Re-export from shared
export {
  type DeployResult,
  type DeployTableResult,
  type DeployAllResult,
  type DeployInput
} from "./shared";

// Re-export from deploy-table
export { deployTable, deployAllTables } from "./deploy-table";

// Re-export from deploy-api
export { deploy } from "./deploy-api";

// Import for internal use
import { type DeployInput, type DeployResult, type DeployTableResult } from "./shared";
import { deployTableFunction } from "./deploy-table";
import { deployApp, type DeployAppResult } from "./deploy-app";
import { deployStaticSite, type DeployStaticSiteResult } from "./deploy-static-site";
import { deployFifoQueueFunction, type DeployFifoQueueResult } from "./deploy-fifo-queue";
import { deployBucketFunction, type DeployBucketResult } from "./deploy-bucket";
import { deployMailer, type DeployMailerResult } from "./deploy-mailer";
import { deployApiFunction } from "./deploy-api";

// ============ Progress tracking ============

type StepStatus = "created" | "updated" | "unchanged";

const statusLabel = (status: StepStatus) => {
  switch (status) {
    case "created": return c.green("created");
    case "updated": return c.yellow("updated");
    case "unchanged": return c.dim("unchanged");
  }
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type HandlerManifest = { name: string; type: string }[];

/**
 * Create a live progress tracker.
 * TTY mode: pre-prints all handler lines with a spinner, then updates them in place via ANSI escape codes.
 * Non-TTY mode (CI): prints each line sequentially as handlers complete.
 */
const createLiveProgress = (manifest: HandlerManifest) => {
  const isTTY = process.stdout.isTTY ?? false;
  const lineIndex = new Map<string, number>();
  manifest.forEach((h, i) => lineIndex.set(`${h.name}:${h.type}`, i));

  const results = new Map<string, StepStatus>();
  const startTime = Date.now();
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (isTTY) {
    for (const h of manifest) {
      process.stdout.write(`  ${c.dim(`${h.name} (${h.type})`)} ${c.cyan(SPINNER[0]!)}\n`);
    }
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER.length;
      for (const h of manifest) {
        const key = `${h.name}:${h.type}`;
        if (results.has(key)) continue;
        const idx = lineIndex.get(key)!;
        const up = manifest.length - idx;
        const line = `  ${c.dim(`${h.name} (${h.type})`)} ${c.cyan(SPINNER[frame]!)}`;
        process.stdout.write(`\x1b[${up}A\x1b[2K${line}\x1b[${up}B\x1b[G`);
      }
    }, 80);
  }

  const formatDuration = () => {
    const sec = ((Date.now() - startTime) / 1000).toFixed(1);
    return c.dim(`${sec}s`);
  };

  return (name: string, type: string, status: StepStatus): Effect.Effect<void> =>
    Effect.sync(() => {
      const key = `${name}:${type}`;
      results.set(key, status);
      const line = `  ${name} ${c.dim(`(${type})`)} ${statusLabel(status)} ${formatDuration()}`;

      if (isTTY) {
        const idx = lineIndex.get(key) ?? 0;
        const up = manifest.length - idx;
        process.stdout.write(`\x1b[${up}A\x1b[2K${line}\x1b[${up}B\x1b[G`);
        if (results.size === manifest.length && timer) {
          clearInterval(timer);
        }
      } else {
        process.stdout.write(`  ${c.dim(`[${results.size}/${manifest.length}]`)} ${name} ${c.dim(`(${type})`)} ${statusLabel(status)} ${formatDuration()}\n`);
      }
    });
};

const DEPLOY_CONCURRENCY = 5;

// ============ Layer preparation ============

type PrepareLayerInput = {
  project: string;
  stage: string;
  region: string;
  /** Directory with package.json and node_modules (= cwd) */
  packageDir: string;
};

const prepareLayer = (input: PrepareLayerInput) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.packageDir
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region: input.region }
        })
      )
    );

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.packageDir)
      : [];
    const { packages: external, warnings: layerWarnings } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(input.packageDir, prodDeps))
      : { packages: [] as string[], warnings: [] as string[] };

    for (const warning of layerWarnings) {
      yield* Effect.logWarning(`[layer] ${warning}`);
    }

    yield* Effect.logDebug(`Layer result: ${layerResult ? "exists" : "null"}, external packages: ${external.length}`);
    if (external.length > 0) {
      yield* Effect.logDebug(`Bundling with ${external.length} external packages from layer`);
    }

    return {
      layerArn: layerResult?.layerVersionArn,
      layerVersion: layerResult?.version,
      layerStatus: layerResult?.status,
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

const BUCKET_CLIENT_PERMISSIONS = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:ListBucket",
] as const;

const SES_PERMISSIONS = [
  "ses:SendEmail",
  "ses:SendRawEmail",
] as const;

/**
 * Build a map of all mailer handler export names to their domains.
 */
const buildMailerDomainMap = (
  mailerHandlers: DiscoveredHandlers["mailerHandlers"],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of mailerHandlers) {
    for (const fn of exports) {
      map.set(fn.exportName, fn.config.domain);
    }
  }
  return map;
};

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
      const handlerName = fn.exportName;
      map.set(fn.exportName, `${project}-${stage}-${handlerName}`);
    }
  }
  return map;
};

/**
 * Build a map of all bucket handler export names to their resolved S3 bucket names.
 * Bucket names are deterministic: ${project}-${stage}-${handlerName}
 */
const buildBucketNameMap = (
  bucketHandlers: DiscoveredHandlers["bucketHandlers"],
  project: string,
  stage: string,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of bucketHandlers) {
    for (const fn of exports) {
      const handlerName = fn.exportName;
      map.set(fn.exportName, `${project}-${stage}-${handlerName}`);
    }
  }
  return map;
};

/**
 * Validate that all handler deps reference a discovered table, bucket, or mailer.
 * Returns a list of human-readable error strings (empty = all valid).
 */
const validateDeps = (
  discovered: DiscoveredHandlers,
  tableNameMap: Map<string, string>,
  bucketNameMap: Map<string, string>,
  mailerDomainMap: Map<string, string>,
): string[] => {
  const errors: string[] = [];
  const allGroups = [
    ...discovered.apiHandlers,
    ...discovered.tableHandlers,
    ...discovered.fifoQueueHandlers,
    ...discovered.bucketHandlers,
    ...discovered.staticSiteHandlers,
    ...discovered.appHandlers,
    ...discovered.mailerHandlers,
  ];
  for (const { exports } of allGroups) {
    for (const fn of exports) {
      for (const key of fn.depsKeys) {
        if (!tableNameMap.has(key) && !bucketNameMap.has(key) && !mailerDomainMap.has(key)) {
          errors.push(
            `Handler "${fn.exportName}" depends on "${key}", but no matching table, bucket, or mailer handler was found. Make sure it is exported.`
          );
        }
      }
    }
  }
  return errors;
};

/**
 * Resolve deps keys to environment variables and IAM permissions.
 * Checks table, bucket, and mailer name maps.
 */
const resolveDeps = (
  depsKeys: string[],
  tableNameMap: Map<string, string>,
  bucketNameMap: Map<string, string>,
  mailerDomainMap: Map<string, string>,
): { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined => {
  if (depsKeys.length === 0) return undefined;

  const depsEnv: Record<string, string> = {};
  let hasTable = false;
  let hasBucket = false;
  let hasMailer = false;

  for (const key of depsKeys) {
    const tableName = tableNameMap.get(key);
    if (tableName) {
      depsEnv[`EFF_DEP_${key}`] = `table:${tableName}`;
      hasTable = true;
      continue;
    }
    const bucketName = bucketNameMap.get(key);
    if (bucketName) {
      depsEnv[`EFF_DEP_${key}`] = `bucket:${bucketName}`;
      hasBucket = true;
      continue;
    }
    const mailerDomain = mailerDomainMap.get(key);
    if (mailerDomain) {
      depsEnv[`EFF_DEP_${key}`] = `mailer:${mailerDomain}`;
      hasMailer = true;
    }
  }

  if (Object.keys(depsEnv).length === 0) return undefined;

  const permissions: string[] = [];
  if (hasTable) permissions.push(...TABLE_CLIENT_PERMISSIONS);
  if (hasBucket) permissions.push(...BUCKET_CLIENT_PERMISSIONS);
  if (hasMailer) permissions.push(...SES_PERMISSIONS);

  return { depsEnv, depsPermissions: permissions };
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

// ============ Parallel deploy task builders ============

type DeployTaskCtx = {
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
  stage: string;
  tableNameMap: Map<string, string>;
  bucketNameMap: Map<string, string>;
  mailerDomainMap: Map<string, string>;
  logComplete: (name: string, type: string, status: StepStatus) => Effect.Effect<void>;
};

const makeDeployInput = (ctx: DeployTaskCtx, file: string): DeployInput => ({
  projectDir: ctx.input.projectDir,
  file,
  project: ctx.input.project,
  region: ctx.input.region,
  ...(ctx.input.stage ? { stage: ctx.input.stage } : {}),
});

const resolveHandlerEnv = (
  depsKeys: string[],
  paramEntries: ParamEntry[],
  ctx: DeployTaskCtx,
) => {
  const resolved = mergeResolved(
    resolveDeps(depsKeys, ctx.tableNameMap, ctx.bucketNameMap, ctx.mailerDomainMap),
    resolveParams(paramEntries, ctx.input.project, ctx.stage)
  );
  return {
    depsEnv: resolved?.depsEnv ?? {},
    depsPermissions: resolved?.depsPermissions ?? [],
  };
};

const buildTableTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["tableHandlers"],
  results: DeployTableResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.paramEntries, ctx);
          const result = yield* deployTableFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, dynamodb: { region } })));
          results.push(result);
          yield* ctx.logComplete( fn.exportName, "table", result.status);
        })
      );
    }
  }
  return tasks;
};

const buildAppTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["appHandlers"],
  results: DeployAppResult[],
  apiOriginDomain?: string,
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const result = yield* deployApp({
            projectDir: ctx.input.projectDir, project: ctx.input.project,
            stage: ctx.input.stage, region, fn, verbose: ctx.input.verbose,
            ...(apiOriginDomain ? { apiOriginDomain } : {}),
          }).pipe(Effect.provide(Aws.makeClients({
            lambda: { region }, iam: { region }, s3: { region },
            cloudfront: { region: "us-east-1" },
            resource_groups_tagging_api: { region: "us-east-1" },
            acm: { region: "us-east-1" },
          })));
          results.push(result);
          yield* ctx.logComplete(fn.exportName, "app", "updated");
        })
      );
    }
  }
  return tasks;
};

const buildStaticSiteTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["staticSiteHandlers"],
  results: DeployStaticSiteResult[],
  apiOriginDomain?: string,
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const result = yield* deployStaticSite({
            projectDir: ctx.input.projectDir, project: ctx.input.project,
            stage: ctx.input.stage, region, fn, verbose: ctx.input.verbose,
            ...(fn.hasHandler ? { file } : {}),
            ...(apiOriginDomain ? { apiOriginDomain } : {}),
          }).pipe(Effect.provide(Aws.makeClients({
            s3: { region }, cloudfront: { region: "us-east-1" },
            resource_groups_tagging_api: { region: "us-east-1" },
            acm: { region: "us-east-1" },
          })));
          results.push(result);
          yield* ctx.logComplete( fn.exportName, "site", "updated");
        })
      );
    }
  }
  return tasks;
};

const buildFifoQueueTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["fifoQueueHandlers"],
  results: DeployFifoQueueResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.paramEntries, ctx);
          const result = yield* deployFifoQueueFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, sqs: { region } })));
          results.push(result);
          yield* ctx.logComplete( fn.exportName, "queue", result.status);
        })
      );
    }
  }
  return tasks;
};

const buildBucketTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["bucketHandlers"],
  results: DeployBucketResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.paramEntries, ctx);
          const result = yield* deployBucketFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, s3: { region } })));
          results.push(result);
          const status = result.status === "resource-only" ? "created" : result.status;
          yield* ctx.logComplete(fn.exportName, "bucket", status);
        })
      );
    }
  }
  return tasks;
};

const buildMailerTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["mailerHandlers"],
  results: DeployMailerResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const result = yield* deployMailer({
            project: ctx.input.project,
            stage: ctx.input.stage,
            region,
            fn,
          }).pipe(Effect.provide(Aws.makeClients({ sesv2: { region } })));
          results.push(result);
          yield* ctx.logComplete(fn.exportName, "mailer", result.verified ? "unchanged" : "created");
        })
      );
    }
  }
  return tasks;
};

const buildApiTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["apiHandlers"],
  results: DeployResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.paramEntries, ctx);
          const { exportName, functionArn, status, handlerName } = yield* deployApiFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region } })));

          // Setup Function URL with CORS
          const lambdaName = `${ctx.input.project}-${ctx.stage}-${handlerName}`;
          const { functionUrl } = yield* ensureFunctionUrl(lambdaName).pipe(
            Effect.provide(Aws.makeClients({ lambda: { region } }))
          );
          yield* addFunctionUrlPublicAccess(lambdaName).pipe(
            Effect.provide(Aws.makeClients({ lambda: { region } }))
          );

          results.push({ exportName, url: functionUrl, functionArn });
          yield* ctx.logComplete(exportName, "api", status);
        })
      );
    }
  }
  return tasks;
};

// ============ Project deployment ============

export type DeployProjectInput = {
  projectDir: string;
  /** Directory with package.json and node_modules (= cwd). Falls back to projectDir. */
  packageDir?: string;
  patterns: string[];
  project: string;
  stage?: string;
  region: string;
  noSites?: boolean;
  verbose?: boolean;
};

export type DeployProjectResult = {
  tableResults: DeployTableResult[];
  appResults: DeployAppResult[];
  staticSiteResults: DeployStaticSiteResult[];
  fifoQueueResults: DeployFifoQueueResult[];
  bucketResults: DeployBucketResult[];
  mailerResults: DeployMailerResult[];
  apiResults: DeployResult[];
};

export const deployProject = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    const stage = resolveStage(input.stage);

    // Discover handlers from file patterns
    const files = findHandlerFiles(input.patterns, input.projectDir);

    if (files.length === 0) {
      return yield* Effect.fail(new Error(`No files match patterns: ${input.patterns.join(", ")}`));
    }

    yield* Effect.logDebug(`Found ${files.length} file(s) matching patterns`);

    const { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers } = discoverHandlers(files);

    const totalTableHandlers = tableHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalAppHandlers = appHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalStaticSiteHandlers = input.noSites ? 0 : staticSiteHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalFifoQueueHandlers = fifoQueueHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalBucketHandlers = bucketHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalMailerHandlers = mailerHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalApiHandlers = apiHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalAllHandlers = totalTableHandlers + totalAppHandlers + totalStaticSiteHandlers + totalFifoQueueHandlers + totalBucketHandlers + totalMailerHandlers + totalApiHandlers;

    if (totalAllHandlers === 0) {
      return yield* Effect.fail(new Error("No handlers found in matched files"));
    }

    const parts: string[] = [];
    if (totalTableHandlers > 0) parts.push(`${totalTableHandlers} table`);
    if (totalAppHandlers > 0) parts.push(`${totalAppHandlers} app`);
    if (totalStaticSiteHandlers > 0) parts.push(`${totalStaticSiteHandlers} site`);
    if (totalFifoQueueHandlers > 0) parts.push(`${totalFifoQueueHandlers} queue`);
    if (totalBucketHandlers > 0) parts.push(`${totalBucketHandlers} bucket`);
    if (totalMailerHandlers > 0) parts.push(`${totalMailerHandlers} mailer`);
    if (totalApiHandlers > 0) parts.push(`${totalApiHandlers} api`);
    yield* Console.log(`\n  ${c.dim("Handlers:")} ${parts.join(", ")}`);

    // Check for missing SSM parameters
    const discovered = { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers };
    const requiredParams = collectRequiredParams(discovered, input.project, stage);
    if (requiredParams.length > 0) {
      const { missing } = yield* checkMissingParams(requiredParams).pipe(
        Effect.provide(Aws.makeClients({ ssm: { region: input.region } }))
      );
      if (missing.length > 0) {
        yield* Console.log(`\n  ${c.yellow("⚠")} Missing ${missing.length} SSM parameter(s):\n`);
        for (const p of missing) {
          yield* Console.log(`    ${c.dim(p.handlerName)} → ${c.yellow(p.ssmPath)}`);
        }
        yield* Console.log(`\n  Run: ${c.cyan(`npx eff config --stage ${stage}`)}`);
      }
    }

    // Build resource maps for deps resolution
    const tableNameMap = buildTableNameMap(tableHandlers, input.project, stage);
    const bucketNameMap = buildBucketNameMap(bucketHandlers, input.project, stage);
    const mailerDomainMap = buildMailerDomainMap(mailerHandlers);

    // Validate deps references before deploying anything
    const depsErrors = validateDeps(discovered, tableNameMap, bucketNameMap, mailerDomainMap);
    if (depsErrors.length > 0) {
      yield* Console.log("");
      for (const err of depsErrors) {
        yield* Console.log(`  ${c.red("✗")} ${err}`);
      }
      return yield* Effect.fail(new Error("Unresolved deps — aborting deploy"));
    }

    // Prepare layer only when Lambda-based handlers exist
    const needsLambda = totalTableHandlers + totalAppHandlers + totalFifoQueueHandlers + totalBucketHandlers + totalMailerHandlers + totalApiHandlers > 0;
    const { layerArn, layerVersion, layerStatus, external } = needsLambda
      ? yield* prepareLayer({
          project: input.project,
          stage: stage,
          region: input.region,
          packageDir: input.packageDir ?? input.projectDir
        })
      : { layerArn: undefined, layerVersion: undefined, layerStatus: undefined, external: [] as string[] };

    if (layerArn && layerStatus) {
      const status = layerStatus === "cached" ? c.dim("cached") : c.green("created");
      yield* Console.log(`  ${c.dim("Layer:")} ${status} ${c.dim(`v${layerVersion}`)} (${external.length} packages)`);
    }

    yield* Console.log("");

    // Build handler manifest and live progress tracker
    const manifest: HandlerManifest = [];
    for (const { exports } of tableHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "table" });
    for (const { exports } of appHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "app" });
    if (!input.noSites) {
      for (const { exports } of staticSiteHandlers)
        for (const fn of exports) manifest.push({ name: fn.exportName, type: "site" });
    }
    for (const { exports } of fifoQueueHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "queue" });
    for (const { exports } of bucketHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "bucket" });
    for (const { exports } of mailerHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "mailer" });
    for (const { exports } of apiHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "api" });

    manifest.sort((a, b) => a.name.localeCompare(b.name));
    const logComplete = createLiveProgress(manifest);
    const ctx: DeployTaskCtx = {
      input, layerArn, external, stage, tableNameMap, bucketNameMap, mailerDomainMap, logComplete,
    };

    const tableResults: DeployTableResult[] = [];
    const appResults: DeployAppResult[] = [];
    const staticSiteResults: DeployStaticSiteResult[] = [];
    const fifoQueueResults: DeployFifoQueueResult[] = [];
    const bucketResults: DeployBucketResult[] = [];
    const mailerResults: DeployMailerResult[] = [];
    const apiResults: DeployResult[] = [];

    // Check if app/site handlers need API origin (for CloudFront proxying)
    const staticSitesNeedApi = !input.noSites && staticSiteHandlers.some(
      ({ exports }) => exports.some(fn => fn.routePatterns.length > 0)
    );
    const appsNeedApi = appHandlers.some(
      ({ exports }) => exports.some(fn => fn.routePatterns.length > 0)
    );
    const needsTwoPhase = (staticSitesNeedApi || appsNeedApi) && totalApiHandlers > 0;

    if (needsTwoPhase) {
      // Phase 1: Deploy everything except app/site (need Function URL from API handlers)
      const phase1Tasks = [
        ...buildApiTasks(ctx, apiHandlers, apiResults),
        ...buildTableTasks(ctx, tableHandlers, tableResults),
        ...buildFifoQueueTasks(ctx, fifoQueueHandlers, fifoQueueResults),
        ...buildBucketTasks(ctx, bucketHandlers, bucketResults),
        ...buildMailerTasks(ctx, mailerHandlers, mailerResults),
      ];

      yield* Effect.all(phase1Tasks, { concurrency: DEPLOY_CONCURRENCY, discard: true });

      // Extract API origin domain from first API handler's Function URL
      const firstApiUrl = apiResults[0]?.url;
      const apiOriginDomain = firstApiUrl
        ? firstApiUrl.replace("https://", "").replace(/\/$/, "")
        : undefined;

      // Phase 2: Deploy app/site handlers with API origin
      const phase2Tasks = [
        ...buildAppTasks(ctx, appHandlers, appResults, apiOriginDomain),
        ...(input.noSites ? [] : buildStaticSiteTasks(ctx, staticSiteHandlers, staticSiteResults, apiOriginDomain)),
      ];

      if (phase2Tasks.length > 0) {
        yield* Effect.all(phase2Tasks, { concurrency: DEPLOY_CONCURRENCY, discard: true });
      }
    } else {
      // Single phase: deploy everything in parallel
      const tasks = [
        ...buildApiTasks(ctx, apiHandlers, apiResults),
        ...buildTableTasks(ctx, tableHandlers, tableResults),
        ...buildAppTasks(ctx, appHandlers, appResults),
        ...(input.noSites ? [] : buildStaticSiteTasks(ctx, staticSiteHandlers, staticSiteResults)),
        ...buildFifoQueueTasks(ctx, fifoQueueHandlers, fifoQueueResults),
        ...buildBucketTasks(ctx, bucketHandlers, bucketResults),
        ...buildMailerTasks(ctx, mailerHandlers, mailerResults),
      ];

      yield* Effect.all(tasks, { concurrency: DEPLOY_CONCURRENCY, discard: true });
    }

    // Clean up orphaned CloudFront Functions (e.g. after rename or config change)
    if ((!input.noSites && staticSiteResults.length > 0) || appResults.length > 0) {
      yield* cleanupOrphanedFunctions(input.project, stage).pipe(
        Effect.provide(Aws.makeClients({
          cloudfront: { region: "us-east-1" },
          resource_groups_tagging_api: { region: "us-east-1" },
        })),
        Effect.catchAll(error =>
          Effect.logDebug(`CloudFront Function cleanup failed (non-fatal): ${error}`)
        )
      );
    }

    return { tableResults, appResults, staticSiteResults, fifoQueueResults, bucketResults, mailerResults, apiResults };
  });
