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
import type { SecretEntry } from "~/build/handler-registry";
import * as crypto from "crypto";
import { ssm } from "~/aws/clients";
import { collectRequiredSecrets, checkMissingSecrets } from "./resolve-config";

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
import { type DeployInput, type DeployResult, type DeployTableResult, flushDeferredWarnings } from "./shared";
import { deployTableFunction } from "./deploy-table";
import { deployApp, type DeployAppResult } from "./deploy-app";
import { deployStaticSite, type DeployStaticSiteResult } from "./deploy-static-site";
import { deployFifoQueueFunction, type DeployFifoQueueResult } from "./deploy-fifo-queue";
import { deployBucketFunction, type DeployBucketResult } from "./deploy-bucket";
import { deployMailer, type DeployMailerResult } from "./deploy-mailer";
import { deployCronFunction, type DeployCronResult } from "./deploy-cron";
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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(0)}KB`;
    return `${(kb / 1024).toFixed(1)}MB`;
  };

  return (name: string, type: string, status: StepStatus, bundleSize?: number): Effect.Effect<void> =>
    Effect.sync(() => {
      const key = `${name}:${type}`;
      results.set(key, status);
      const sizeInfo = bundleSize ? ` ${c.dim(formatSize(bundleSize))}` : "";
      const line = `  ${name} ${c.dim(`(${type})`)} ${statusLabel(status)}${sizeInfo} ${formatDuration()}`;

      if (isTTY) {
        const idx = lineIndex.get(key) ?? 0;
        const up = manifest.length - idx;
        process.stdout.write(`\x1b[${up}A\x1b[2K${line}\x1b[${up}B\x1b[G`);
        if (results.size === manifest.length && timer) {
          clearInterval(timer);
        }
      } else {
        process.stdout.write(`  ${c.dim(`[${results.size}/${manifest.length}]`)} ${name} ${c.dim(`(${type})`)} ${statusLabel(status)}${sizeInfo} ${formatDuration()}\n`);
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
  extraNodeModules?: string[];
};

const prepareLayer = (input: PrepareLayerInput) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.packageDir,
      extraNodeModules: input.extraNodeModules
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
    const { packages: external } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(input.packageDir, prodDeps, input.extraNodeModules))
      : { packages: [] as string[] };

    yield* Effect.logDebug(`Layer result: ${layerResult ? "exists" : "null"}, external packages: ${external.length}`);
    if (external.length > 0) {
      yield* Effect.logDebug(`Bundling with ${external.length} external packages from layer`);
    }

    return {
      layerArn: layerResult?.layerVersionArn,
      layerVersion: layerResult?.version,
      layerStatus: layerResult?.status,
      external,
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

const QUEUE_CLIENT_PERMISSIONS = [
  "sqs:SendMessage",
  "sqs:SendMessageBatch",
  "sqs:GetQueueUrl",
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
 * Build a map of all FIFO queue handler export names to their resolved queue names.
 * Queue names are deterministic: ${project}-${stage}-${handlerName}
 */
const buildQueueNameMap = (
  fifoQueueHandlers: DiscoveredHandlers["fifoQueueHandlers"],
  project: string,
  stage: string,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of fifoQueueHandlers) {
    for (const fn of exports) {
      map.set(fn.exportName, `${project}-${stage}-${fn.exportName}`);
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
  queueNameMap: Map<string, string>,
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
    ...discovered.cronHandlers,
  ];
  for (const { exports } of allGroups) {
    for (const fn of exports) {
      for (const key of fn.depsKeys) {
        if (!tableNameMap.has(key) && !bucketNameMap.has(key) && !mailerDomainMap.has(key) && !queueNameMap.has(key)) {
          errors.push(
            `Handler "${fn.exportName}" depends on "${key}", but no matching table, bucket, mailer, or queue handler was found. Make sure it is exported.`
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
  queueNameMap: Map<string, string>,
): { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined => {
  if (depsKeys.length === 0) return undefined;

  const depsEnv: Record<string, string> = {};
  let hasTable = false;
  let hasBucket = false;
  let hasMailer = false;
  let hasQueue = false;

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
      continue;
    }
    const queueName = queueNameMap.get(key);
    if (queueName) {
      depsEnv[`EFF_DEP_${key}`] = `queue:${queueName}`;
      hasQueue = true;
    }
  }

  if (Object.keys(depsEnv).length === 0) return undefined;

  const permissions: string[] = [];
  if (hasTable) permissions.push(...TABLE_CLIENT_PERMISSIONS);
  if (hasBucket) permissions.push(...BUCKET_CLIENT_PERMISSIONS);
  if (hasMailer) permissions.push(...SES_PERMISSIONS);
  if (hasQueue) permissions.push(...QUEUE_CLIENT_PERMISSIONS);

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
/** Execute a generate DSL string to produce a secret value at deploy time. */
const executeGenerate = (spec: string): string => {
  if (spec === "uuid") return crypto.randomUUID();
  const hexMatch = spec.match(/^hex:(\d+)$/);
  if (hexMatch) return crypto.randomBytes(Number(hexMatch[1])).toString("hex");
  const base64Match = spec.match(/^base64:(\d+)$/);
  if (base64Match) return crypto.randomBytes(Number(base64Match[1])).toString("base64url");
  throw new Error(`Unknown generate spec: "${spec}". Use "hex:N", "base64:N", or "uuid".`);
};

const resolveSecrets = (
  secretEntries: SecretEntry[],
  project: string,
  stage: string
): { paramsEnv: Record<string, string>; paramsPermissions: readonly string[] } | undefined => {
  if (secretEntries.length === 0) return undefined;

  const paramsEnv: Record<string, string> = {};
  for (const { propName, ssmKey } of secretEntries) {
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
  queueNameMap: Map<string, string>;
  logComplete: (name: string, type: string, status: StepStatus, bundleSize?: number) => Effect.Effect<void>;
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
  secretEntries: SecretEntry[],
  ctx: DeployTaskCtx,
) => {
  const resolved = mergeResolved(
    resolveDeps(depsKeys, ctx.tableNameMap, ctx.bucketNameMap, ctx.mailerDomainMap, ctx.queueNameMap),
    resolveSecrets(secretEntries, ctx.input.project, ctx.stage)
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
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const result = yield* deployTableFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, dynamodb: { region } })));
          results.push(result);
          yield* ctx.logComplete( fn.exportName, "table", result.status, result.bundleSize);
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
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const result = yield* deployFifoQueueFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, sqs: { region } })));
          results.push(result);
          yield* ctx.logComplete( fn.exportName, "queue", result.status, result.bundleSize);
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
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const result = yield* deployBucketFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, s3: { region } })));
          results.push(result);
          const status = result.status === "resource-only" ? "created" : result.status;
          yield* ctx.logComplete(fn.exportName, "bucket", status, result.bundleSize);
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
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const { exportName, functionArn, status, bundleSize, handlerName } = yield* deployApiFunction({
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
          yield* ctx.logComplete(exportName, "api", status, bundleSize);
        })
      );
    }
  }
  return tasks;
};

const buildCronTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["cronHandlers"],
  results: DeployCronResult[],
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const result = yield* deployCronFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region }, scheduler: { region } })));
          results.push(result);
          yield* ctx.logComplete(fn.exportName, "cron", result.status, result.bundleSize);
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
  extraNodeModules?: string[];
};

export type DeployProjectResult = {
  tableResults: DeployTableResult[];
  appResults: DeployAppResult[];
  staticSiteResults: DeployStaticSiteResult[];
  fifoQueueResults: DeployFifoQueueResult[];
  bucketResults: DeployBucketResult[];
  mailerResults: DeployMailerResult[];
  cronResults: DeployCronResult[];
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

    const { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers, cronHandlers } = yield* Effect.promise(() => discoverHandlers(files, input.projectDir));

    const totalTableHandlers = tableHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalAppHandlers = appHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalStaticSiteHandlers = input.noSites ? 0 : staticSiteHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalFifoQueueHandlers = fifoQueueHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalBucketHandlers = bucketHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalMailerHandlers = mailerHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalApiHandlers = apiHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalCronHandlers = cronHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalAllHandlers = totalTableHandlers + totalAppHandlers + totalStaticSiteHandlers + totalFifoQueueHandlers + totalBucketHandlers + totalMailerHandlers + totalApiHandlers + totalCronHandlers;

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
    if (totalCronHandlers > 0) parts.push(`${totalCronHandlers} cron`);
    yield* Console.log(`\n  ${c.dim("Handlers:")} ${parts.join(", ")}`);

    // Check for missing SSM parameters
    const discovered = { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers, cronHandlers };
    const requiredSecrets = collectRequiredSecrets(discovered, input.project, stage);
    if (requiredSecrets.length > 0) {
      const { missing } = yield* checkMissingSecrets(requiredSecrets).pipe(
        Effect.provide(Aws.makeClients({ ssm: { region: input.region } }))
      );

      // Auto-create secrets that have generators
      const withGenerators = missing.filter(m => m.generate);
      const manualOnly = missing.filter(m => !m.generate);

      if (withGenerators.length > 0) {
        for (const entry of withGenerators) {
          const value = executeGenerate(entry.generate!);
          yield* ssm.make("put_parameter", {
            Name: entry.ssmPath,
            Value: value,
            Type: "SecureString",
          }).pipe(Effect.provide(Aws.makeClients({ ssm: { region: input.region } })));
          yield* Effect.logDebug(`Auto-created SSM parameter: ${entry.ssmPath}`);
        }
        yield* Console.log(`\n  ${c.green("✓")} Auto-created ${withGenerators.length} secret(s)`);
      }

      if (manualOnly.length > 0) {
        yield* Console.log(`\n  ${c.yellow("⚠")} Missing ${manualOnly.length} SSM parameter(s):\n`);
        for (const p of manualOnly) {
          yield* Console.log(`    ${c.dim(p.handlerName)} → ${c.yellow(p.ssmPath)}`);
        }
        yield* Console.log(`\n  Run: ${c.cyan(`npx eff config --stage ${stage}`)}`);
      }
    }

    // Build resource maps for deps resolution
    const tableNameMap = buildTableNameMap(tableHandlers, input.project, stage);
    const bucketNameMap = buildBucketNameMap(bucketHandlers, input.project, stage);
    const mailerDomainMap = buildMailerDomainMap(mailerHandlers);
    const queueNameMap = buildQueueNameMap(fifoQueueHandlers, input.project, stage);

    // Validate deps references before deploying anything
    const depsErrors = validateDeps(discovered, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap);
    if (depsErrors.length > 0) {
      yield* Console.log("");
      for (const err of depsErrors) {
        yield* Console.log(`  ${c.red("✗")} ${err}`);
      }
      return yield* Effect.fail(new Error("Unresolved deps — aborting deploy"));
    }

    // Prepare layer only when Lambda-based handlers exist
    const needsLambda = totalTableHandlers + totalAppHandlers + totalFifoQueueHandlers + totalBucketHandlers + totalMailerHandlers + totalApiHandlers + totalCronHandlers > 0;
    const { layerArn, layerVersion, layerStatus, external } = needsLambda
      ? yield* prepareLayer({
          project: input.project,
          stage: stage,
          region: input.region,
          packageDir: input.packageDir ?? input.projectDir,
          extraNodeModules: input.extraNodeModules
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
    for (const { exports } of cronHandlers)
      for (const fn of exports) manifest.push({ name: fn.exportName, type: "cron" });

    manifest.sort((a, b) => a.name.localeCompare(b.name));
    const logComplete = createLiveProgress(manifest);
    const ctx: DeployTaskCtx = {
      input, layerArn, external, stage, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap, logComplete,
    };

    const tableResults: DeployTableResult[] = [];
    const appResults: DeployAppResult[] = [];
    const staticSiteResults: DeployStaticSiteResult[] = [];
    const fifoQueueResults: DeployFifoQueueResult[] = [];
    const bucketResults: DeployBucketResult[] = [];
    const mailerResults: DeployMailerResult[] = [];
    const cronResults: DeployCronResult[] = [];
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
        ...buildCronTasks(ctx, cronHandlers, cronResults),
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
        ...buildCronTasks(ctx, cronHandlers, cronResults),
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

    // Show deferred warnings after progress spinner is done
    for (const warning of flushDeferredWarnings()) {
      yield* Effect.logWarning(warning);
    }

    return { tableResults, appResults, staticSiteResults, fifoQueueResults, bucketResults, mailerResults, cronResults, apiResults };
  });
