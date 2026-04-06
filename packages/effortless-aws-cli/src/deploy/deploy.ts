import { Effect, Console } from "effect";
import { c } from "~/cli/colors";
import {
  Aws,
  resolveStage,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages,
  findDepsDir,
  cleanupOrphanedFunctions,
  ensureFunctionUrl,
  addFunctionUrlPublicAccess,
  ensurePublicKey,
  ensureKeyGroup,
  findDistributionByTags,
} from "../aws";
import { findHandlerFiles, discoverHandlers, flattenHandlers, type DiscoveredHandlers, bundle } from "~/build/bundle";
import type { HandlerType } from "~/build/handler-registry";
import { toSeconds } from "effortless-aws";
import type { SecretEntry } from "~/build/handler-registry";
import * as crypto from "crypto";
import * as path from "path";
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
import { type DeployInput, type DeployResult, type DeployTableResult, flushDeferredWarnings, startBundleCollector, flushBundleCollector, collectBundle, startDeployLog, flushDeployLog, logDeploy, formatBytes } from "./shared";
import { deployTableFunction } from "./deploy-table";
import { deployApp, type DeployAppResult } from "./deploy-app";
import { deployStaticSite, type DeployStaticSiteResult } from "./deploy-static-site";
import { deployFifoQueueFunction, type DeployFifoQueueResult } from "./deploy-fifo-queue";
import { deployBucketFunction, type DeployBucketResult } from "./deploy-bucket";
import { deployMailer, type DeployMailerResult } from "./deploy-mailer";
import { deployCronFunction, type DeployCronResult } from "./deploy-cron";
import { deployWorkerFunction, type DeployWorkerResult } from "./deploy-worker";
import { deployApiFunction } from "./deploy-api";
import { deployMcpFunction } from "./deploy-mcp";
import { writeDeployState } from "./state";

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
const createLiveProgress = (manifest: HandlerManifest, silent = false) => {
  if (silent) {
    return (_name: string, _type: string, _status: StepStatus, _bundleSize?: number): Effect.Effect<void> =>
      Effect.void;
  }

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
  depsDir: string;
};

const prepareLayer = (input: PrepareLayerInput) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      projectDir: input.depsDir,
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region: input.region }
        })
      )
    );

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.depsDir)
      : [];
    const { packages: external } = prodDeps.length > 0
      ? yield* Effect.sync(() => collectLayerPackages(input.depsDir, prodDeps))
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

const WORKER_CLIENT_PERMISSIONS = [
  "sqs:SendMessage",
  "sqs:GetQueueUrl",
  "ecs:DescribeServices",
  "ecs:UpdateService",
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
 * Bucket names are deterministic: ${project}-${stage}-${handlerName} (lowercased for S3 compliance)
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
      map.set(fn.exportName, `${project}-${stage}-${handlerName}`.toLowerCase());
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
 * Build a map of all worker handler export names to their resolved worker names.
 * Worker names are deterministic: ${project}-${stage}-${handlerName}
 */
const buildWorkerNameMap = (
  workerHandlers: DiscoveredHandlers["workerHandlers"],
  project: string,
  stage: string,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of workerHandlers) {
    for (const fn of exports) {
      const idleTimeoutSec = fn.config.idleTimeout ? toSeconds(fn.config.idleTimeout) : 300;
      map.set(fn.exportName, `${project}-${stage}-${fn.exportName}:${idleTimeoutSec}`);
    }
  }
  return map;
};

/**
 * Validate that all handler deps reference a discovered table, bucket, mailer, queue, or worker.
 * Returns a list of human-readable error strings (empty = all valid).
 */
/** Validate handler export names: no defaults, no duplicates. */
const validateHandlerNames = (discovered: DiscoveredHandlers): string[] => {
  const errors: string[] = [];
  const seen = new Map<string, string[]>();
  const allGroups: { type: string; handlers: { file: string; exports: { exportName: string }[] }[] }[] = [
    { type: "table", handlers: discovered.tableHandlers },
    { type: "app", handlers: discovered.appHandlers },
    { type: "site", handlers: discovered.staticSiteHandlers },
    { type: "queue", handlers: discovered.fifoQueueHandlers },
    { type: "bucket", handlers: discovered.bucketHandlers },
    { type: "mailer", handlers: discovered.mailerHandlers },
    { type: "api", handlers: discovered.apiHandlers },
    { type: "cron", handlers: discovered.cronHandlers },
    { type: "worker", handlers: discovered.workerHandlers },
    { type: "mcp", handlers: discovered.mcpHandlers },
  ];
  for (const { type, handlers } of allGroups) {
    for (const h of handlers) {
      for (const fn of h.exports) {
        if (fn.exportName === "default") {
          errors.push(`Default export in ${h.file} is not supported. Use a named export: export const myHandler = define${type[0]!.toUpperCase()}${type.slice(1)}(...)`);
          continue;
        }
        const key = fn.exportName;
        const label = `${h.file} (${type})`;
        seen.set(key, [...(seen.get(key) ?? []), label]);
      }
    }
  }
  for (const [name, locations] of seen) {
    if (locations.length > 1) {
      errors.push(`Duplicate handler name "${name}": ${locations.join(", ")}`);
    }
  }
  return errors;
};

const validateDeps = (
  discovered: DiscoveredHandlers,
  tableNameMap: Map<string, string>,
  bucketNameMap: Map<string, string>,
  mailerDomainMap: Map<string, string>,
  queueNameMap: Map<string, string>,
  workerNameMap: Map<string, string>,
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
    ...discovered.workerHandlers,
    ...discovered.mcpHandlers,
  ];
  for (const { exports } of allGroups) {
    for (const fn of exports) {
      for (const key of fn.depsKeys) {
        if (!tableNameMap.has(key) && !bucketNameMap.has(key) && !mailerDomainMap.has(key) && !queueNameMap.has(key) && !workerNameMap.has(key)) {
          errors.push(
            `Handler "${fn.exportName}" depends on "${key}", but no matching table, bucket, mailer, queue, or worker handler was found. Make sure it is exported.`
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
  workerNameMap: Map<string, string>,
): { depsEnv: Record<string, string>; depsPermissions: readonly string[] } | undefined => {
  if (depsKeys.length === 0) return undefined;

  const depsEnv: Record<string, string> = {};
  let hasTable = false;
  let hasBucket = false;
  let hasMailer = false;
  let hasQueue = false;
  let hasWorker = false;

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
      continue;
    }
    const workerName = workerNameMap.get(key);
    if (workerName) {
      // Worker dep value will be resolved at deploy time when queue URL and service details are known
      depsEnv[`EFF_DEP_${key}`] = `worker:${workerName}`;
      hasWorker = true;
    }
  }

  if (Object.keys(depsEnv).length === 0) return undefined;

  const permissions: string[] = [];
  if (hasTable) permissions.push(...TABLE_CLIENT_PERMISSIONS);
  if (hasBucket) permissions.push(...BUCKET_CLIENT_PERMISSIONS);
  if (hasMailer) permissions.push(...SES_PERMISSIONS);
  if (hasQueue) permissions.push(...QUEUE_CLIENT_PERMISSIONS);
  if (hasWorker) permissions.push(...WORKER_CLIENT_PERMISSIONS);

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

/** CloudFront signing info for signed cookies (private bucket routes) */
type CfSigningInfo = {
  cfSigningKeySsmPath: string;
  publicKeyId: string;
  keyGroupId: string;
};

type DeployTaskCtx = {
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
  stage: string;
  tableNameMap: Map<string, string>;
  bucketNameMap: Map<string, string>;
  mailerDomainMap: Map<string, string>;
  queueNameMap: Map<string, string>;
  workerNameMap: Map<string, string>;
  logComplete: (name: string, type: string, status: StepStatus, bundleSize?: number) => Effect.Effect<void>;
  cfSigningInfo?: CfSigningInfo;
  /** CloudFront domain for signed cookies (custom domain from static site, or "*") */
  cfDomain?: string;
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
    resolveDeps(depsKeys, ctx.tableNameMap, ctx.bucketNameMap, ctx.mailerDomainMap, ctx.queueNameMap, ctx.workerNameMap),
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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
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
  apiUrlMap?: Map<string, string>,
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
  const { region } = ctx.input;
  for (const { exports } of handlers) {
    for (const fn of exports) {
      // Resolve API routes to actual origin domains
      const apiRoutes = apiUrlMap ? fn.apiRoutes.map(ar => {
        const originDomain = apiUrlMap.get(ar.handlerExport);
        if (!originDomain) throw new Error(`API route "${ar.pattern}" references "${ar.handlerExport}" which was not found`);
        return { pattern: ar.pattern, originDomain };
      }) : [];
      tasks.push(
        Effect.gen(function* () {
          const result = yield* deployApp({
            projectDir: ctx.input.projectDir, project: ctx.input.project,
            stage: ctx.input.stage, region, fn, verbose: ctx.input.verbose,
            ...(apiRoutes.length > 0 ? { apiRoutes } : {}),
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
  apiUrlMap?: Map<string, string>,
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      // Resolve bucket routes to actual bucket names
      const bucketRoutes = fn.bucketRoutes.map(br => {
        const bucketName = ctx.bucketNameMap.get(br.bucketExportName);
        if (!bucketName) throw new Error(`Bucket route "${br.pattern}" references "${br.bucketExportName}" which was not found`);
        return { pattern: br.pattern, bucketName, bucketRegion: region, access: br.access };
      });

      // Resolve API routes to actual origin domains
      const apiRoutes = apiUrlMap ? fn.apiRoutes.map(ar => {
        const originDomain = apiUrlMap.get(ar.handlerExport);
        if (!originDomain) throw new Error(`API route "${ar.pattern}" references "${ar.handlerExport}" which was not found`);
        return { pattern: ar.pattern, originDomain };
      }) : [];

      tasks.push(
        Effect.gen(function* () {
          const result = yield* deployStaticSite({
            projectDir: ctx.input.projectDir, project: ctx.input.project,
            stage: ctx.input.stage, region, fn, verbose: ctx.input.verbose,
            ...(fn.hasHandler ? { file } : {}),
            ...(apiRoutes.length > 0 ? { apiRoutes } : {}),
            ...(bucketRoutes.length > 0 ? { bucketRoutes } : {}),
            ...(ctx.cfSigningInfo ? { cfSigningInfo: ctx.cfSigningInfo } : {}),
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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
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
          yield* ctx.logComplete(fn.exportName, "bucket", result.status, result.bundleSize);
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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);

          // Inject CF signing env vars for signed cookies (private bucket routes)
          if (ctx.cfSigningInfo) {
            env.depsEnv.EFF_CF_SIGNING_KEY = ctx.cfSigningInfo.cfSigningKeySsmPath;
            env.depsEnv.EFF_CF_KEY_PAIR_ID = ctx.cfSigningInfo.publicKeyId;
            env.depsEnv.EFF_CF_DOMAIN = ctx.cfDomain ?? "*";
            // Ensure SSM read permissions are included
            if (!env.depsPermissions.includes("ssm:GetParameter")) {
              env.depsPermissions = [...env.depsPermissions, "ssm:GetParameter", "ssm:GetParameters"];
            }
          }

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
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
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

const buildWorkerTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["workerHandlers"],
  results: DeployWorkerResult[],
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);
          const result = yield* deployWorkerFunction({
            input: makeDeployInput(ctx, file), fn,
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({
            ecs: { region }, iam: { region }, sqs: { region },
            s3: { region }, cloudwatch_logs: { region },
          })));
          results.push(result);
          yield* ctx.logComplete(fn.exportName, "worker", result.status, result.bundleSize);
        })
      );
    }
  }
  return tasks;
};

const buildMcpTasks = (
  ctx: DeployTaskCtx,
  handlers: DiscoveredHandlers["mcpHandlers"],
  results: DeployResult[],
): Effect.Effect<void, unknown, any>[] => {
  const tasks: Effect.Effect<void, unknown, any>[] = [];
  const { region } = ctx.input;
  for (const { file, exports } of handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.secretEntries, ctx);

          const { exportName, functionArn, status, bundleSize, handlerName } = yield* deployMcpFunction({
            input: makeDeployInput(ctx, file), fn,
            ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
            ...(ctx.external.length > 0 ? { external: ctx.external } : {}),
            depsEnv: env.depsEnv, depsPermissions: env.depsPermissions,
            ...(fn.staticGlobs.length > 0 ? { staticGlobs: fn.staticGlobs } : {}),
          }).pipe(Effect.provide(Aws.makeClients({ lambda: { region }, iam: { region } })));

          // Setup Function URL
          const lambdaName = `${ctx.input.project}-${ctx.stage}-${handlerName}`;
          const { functionUrl } = yield* ensureFunctionUrl(lambdaName).pipe(
            Effect.provide(Aws.makeClients({ lambda: { region } }))
          );
          yield* addFunctionUrlPublicAccess(lambdaName).pipe(
            Effect.provide(Aws.makeClients({ lambda: { region } }))
          );

          results.push({ exportName, url: functionUrl, functionArn });
          yield* ctx.logComplete(exportName, "mcp", status, bundleSize);
        })
      );
    }
  }
  return tasks;
};

// ============ Project deployment ============

export type DeployProjectInput = {
  projectDir: string;
  patterns: string[];
  project: string;
  stage?: string;
  region: string;
  noSites?: boolean;
  verbose?: boolean;
  /** Suppress all stdout output (for MCP server where stdout is the transport). */
  silent?: boolean;
  /** Bundle and validate without deploying to AWS. */
  dryRun?: boolean;
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
  mcpResults: DeployResult[];
};

type HandlerCounts = {
  table: number; app: number; site: number; queue: number;
  bucket: number; mailer: number; api: number; cron: number; worker: number; mcp: number;
};

// ---- Phase 1: Discover handlers and validate ----

const discoverAndValidate = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    const stage = resolveStage(input.stage);
    const files = findHandlerFiles(input.patterns, input.projectDir);

    if (files.length === 0) {
      return yield* Effect.fail(new Error(`No files match patterns: ${input.patterns.join(", ")}`));
    }

    yield* Effect.logDebug(`Found ${files.length} file(s) matching patterns`);

    const discovered = yield* discoverHandlers(files, input.projectDir);
    const { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers, cronHandlers, workerHandlers, mcpHandlers } = discovered;

    const counts: HandlerCounts = {
      table: tableHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      app: appHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      site: input.noSites ? 0 : staticSiteHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      queue: fifoQueueHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      bucket: bucketHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      mailer: mailerHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      api: apiHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      cron: cronHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      worker: workerHandlers.reduce((acc, h) => acc + h.exports.length, 0),
      mcp: mcpHandlers.reduce((acc, h) => acc + h.exports.length, 0),
    };
    const countValues = Object.values(counts) as number[];
    const totalAll = countValues.reduce((a, b) => a + b, 0);

    if (totalAll === 0) {
      return yield* Effect.fail(new Error("No handlers found in matched files"));
    }

    const parts = (Object.entries(counts) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${n} ${type}`);
    yield* Console.log(`\n  ${c.dim("Handlers:")} ${parts.join(", ")}`);

    // Validate unique handler names
    const nameErrors = validateHandlerNames(discovered);
    if (nameErrors.length > 0) {
      yield* Console.log("");
      for (const err of nameErrors) {
        yield* Console.log(`  ${c.red("✗")} ${err}`);
      }
      return yield* Effect.fail(new Error("Invalid handler names — see errors above"));
    }

    // Build resource maps for deps resolution
    const tableNameMap = buildTableNameMap(tableHandlers, input.project, stage);
    const bucketNameMap = buildBucketNameMap(bucketHandlers, input.project, stage);
    const mailerDomainMap = buildMailerDomainMap(mailerHandlers);
    const queueNameMap = buildQueueNameMap(fifoQueueHandlers, input.project, stage);
    const workerNameMap = buildWorkerNameMap(workerHandlers, input.project, stage);

    // Validate deps references
    const depsErrors = validateDeps(discovered, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap, workerNameMap);
    if (depsErrors.length > 0) {
      yield* Console.log("");
      for (const err of depsErrors) {
        yield* Console.log(`  ${c.red("✗")} ${err}`);
      }
      return yield* Effect.fail(new Error("Unresolved deps — aborting deploy"));
    }

    return { stage, files, discovered, counts, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap, workerNameMap };
  });

// ---- Phase 2: Ensure secrets and CF signing keys ----

const prepareSecrets = (input: {
  discovered: DiscoveredHandlers;
  project: string;
  stage: string;
  region: string;
  noSites?: boolean;
}) =>
  Effect.gen(function* () {
    const { discovered, project, stage, region } = input;

    // Check for missing SSM parameters
    const requiredSecrets = collectRequiredSecrets(discovered, project, stage);
    if (requiredSecrets.length > 0) {
      const { missing } = yield* checkMissingSecrets(requiredSecrets).pipe(
        Effect.provide(Aws.makeClients({ ssm: { region } }))
      );

      const withGenerators = missing.filter(m => m.generate);
      const manualOnly = missing.filter(m => !m.generate);

      if (withGenerators.length > 0) {
        for (const entry of withGenerators) {
          const value = executeGenerate(entry.generate!);
          yield* ssm.make("put_parameter", {
            Name: entry.ssmPath,
            Value: value,
            Type: "SecureString",
          }).pipe(Effect.provide(Aws.makeClients({ ssm: { region } })));
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

    // Check if any static site has private bucket routes — if so, set up CF signing keys
    const hasPrivateBucketRoutes = !input.noSites && discovered.staticSiteHandlers.some(
      ({ exports }) => exports.some(fn => fn.bucketRoutes.some(br => br.access === "private"))
    );

    let cfSigningInfo: CfSigningInfo | undefined;
    if (hasPrivateBucketRoutes) {
      const cfKeyName = `${project}-${stage}-cf-signing`;
      const cfSigningKeySsmPath = `/${project}/${stage}/cf-signing-key`;

      const { missing: missingCfKey } = yield* checkMissingSecrets([
        { ssmPath: cfSigningKeySsmPath, propName: "cf-signing-key", ssmKey: "cf-signing-key", handlerName: "__cf-signing__", generate: undefined },
      ]).pipe(Effect.provide(Aws.makeClients({ ssm: { region } })));

      if (missingCfKey.length > 0) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });

        yield* ssm.make("put_parameter", {
          Name: cfSigningKeySsmPath,
          Value: privateKey,
          Type: "SecureString",
          Description: `CloudFront signing key for effortless-aws: ${cfKeyName}`,
        }).pipe(Effect.provide(Aws.makeClients({ ssm: { region } })));

        const { publicKeyId } = yield* ensurePublicKey({
          name: cfKeyName,
          publicKeyPem: publicKey,
        }).pipe(Effect.provide(Aws.makeClients({ cloudfront: { region: "us-east-1" } })));

        const { keyGroupId } = yield* ensureKeyGroup({
          name: cfKeyName,
          publicKeyIds: [publicKeyId],
        }).pipe(Effect.provide(Aws.makeClients({ cloudfront: { region: "us-east-1" } })));

        cfSigningInfo = { cfSigningKeySsmPath, publicKeyId, keyGroupId };
        yield* Console.log(`  ${c.green("✓")} Created CloudFront signing key pair`);
      } else {
        const paramResult = yield* ssm.make("get_parameter", {
          Name: cfSigningKeySsmPath,
          WithDecryption: true,
        }).pipe(Effect.provide(Aws.makeClients({ ssm: { region } })));

        const privateKeyPem = paramResult.Parameter!.Value!;
        const publicKeyObj = crypto.createPublicKey(privateKeyPem);
        const publicKeyPem = publicKeyObj.export({ type: "spki", format: "pem" }) as string;

        const { publicKeyId } = yield* ensurePublicKey({
          name: cfKeyName,
          publicKeyPem,
        }).pipe(Effect.provide(Aws.makeClients({ cloudfront: { region: "us-east-1" } })));

        const { keyGroupId } = yield* ensureKeyGroup({
          name: cfKeyName,
          publicKeyIds: [publicKeyId],
        }).pipe(Effect.provide(Aws.makeClients({ cloudfront: { region: "us-east-1" } })));

        cfSigningInfo = { cfSigningKeySsmPath, publicKeyId, keyGroupId };
      }
    }

    return { cfSigningInfo };
  });

// ---- Phase 3: Prepare Lambda layer ----

const prepareLambdaLayer = (input: {
  project: string;
  stage: string;
  region: string;
  files: string[];
  projectDir: string;
  needsLambda: boolean;
}) =>
  Effect.gen(function* () {
    if (!input.needsLambda) {
      return { layerArn: undefined, layerVersion: undefined, external: [] as string[] };
    }

    const depsDir = findDepsDir(path.dirname(input.files[0]!), input.projectDir);
    const { layerArn, layerVersion, layerStatus, external } = yield* prepareLayer({
      project: input.project,
      stage: input.stage,
      region: input.region,
      depsDir,
    });

    if (layerArn && layerStatus) {
      const status = layerStatus === "cached" ? c.dim("cached") : c.green("created");
      yield* Console.log(`  ${c.dim("Layer:")} ${status} ${c.dim(`v${layerVersion}`)} (${external.length} packages)`);
    }

    return { layerArn, layerVersion, external };
  });

// ---- Phase 4: Resolve CF domain for signed cookies ----

const resolveCfDomain = (input: {
  staticSiteHandlers: DiscoveredHandlers["staticSiteHandlers"];
  project: string;
  stage: string;
}) =>
  Effect.gen(function* () {
    for (const { exports } of input.staticSiteHandlers) {
      for (const fn of exports) {
        if (fn.bucketRoutes.some(br => br.access === "private")) {
          const domainCfg = fn.config.domain;
          const d = typeof domainCfg === "string" ? domainCfg : domainCfg?.[input.stage];
          if (d) return d;

          const existing = yield* findDistributionByTags(input.project, input.stage, fn.exportName).pipe(
            Effect.provide(Aws.makeClients({
              resource_groups_tagging_api: { region: "us-east-1" },
              cloudfront: { region: "us-east-1" },
            })),
          );
          if (existing?.DomainName) return existing.DomainName;
        }
      }
    }
    return undefined;
  });

// ---- Phase 5: Deploy all resources ----

const buildManifest = (discovered: DiscoveredHandlers, noSites?: boolean): HandlerManifest => {
  const manifest: HandlerManifest = [];
  const groups: [keyof DiscoveredHandlers, string][] = [
    ["tableHandlers", "table"],
    ["appHandlers", "app"],
    ...(!noSites ? [["staticSiteHandlers", "site"] as [keyof DiscoveredHandlers, string]] : []),
    ["fifoQueueHandlers", "queue"],
    ["bucketHandlers", "bucket"],
    ["mailerHandlers", "mailer"],
    ["apiHandlers", "api"],
    ["cronHandlers", "cron"],
    ["workerHandlers", "worker"],
    ["mcpHandlers", "mcp"],
  ];
  for (const [key, type] of groups) {
    for (const { exports } of discovered[key]) {
      for (const fn of exports) {
        manifest.push({ name: fn.exportName, type });
      }
    }
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  return manifest;
};

const deployResources = (input: {
  ctx: DeployTaskCtx;
  discovered: DiscoveredHandlers;
  counts: HandlerCounts;
}) =>
  Effect.gen(function* () {
    const { ctx, discovered, counts } = input;
    const { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers, cronHandlers, workerHandlers, mcpHandlers } = discovered;
    const noSites = ctx.input.noSites;

    const tableResults: DeployTableResult[] = [];
    const appResults: DeployAppResult[] = [];
    const staticSiteResults: DeployStaticSiteResult[] = [];
    const fifoQueueResults: DeployFifoQueueResult[] = [];
    const bucketResults: DeployBucketResult[] = [];
    const mailerResults: DeployMailerResult[] = [];
    const cronResults: DeployCronResult[] = [];
    const workerResults: DeployWorkerResult[] = [];
    const apiResults: DeployResult[] = [];
    const mcpResults: DeployResult[] = [];

    const staticSitesNeedApi = !noSites && staticSiteHandlers.some(
      ({ exports }) => exports.some(fn => fn.routePatterns.length > 0)
    );
    const staticSitesNeedBuckets = !noSites && staticSiteHandlers.some(
      ({ exports }) => exports.some(fn => fn.bucketRoutes.length > 0)
    );
    const appsNeedApi = appHandlers.some(
      ({ exports }) => exports.some(fn => fn.routePatterns.length > 0)
    );
    const needsTwoPhase = ((staticSitesNeedApi || appsNeedApi) && counts.api > 0) || (staticSitesNeedBuckets && counts.bucket > 0);

    if (needsTwoPhase) {
      // Phase 1: Deploy everything except app/site (need Function URL from API handlers)
      const phase1Tasks = [
        ...buildApiTasks(ctx, apiHandlers, apiResults),
        ...buildTableTasks(ctx, tableHandlers, tableResults),
        ...buildFifoQueueTasks(ctx, fifoQueueHandlers, fifoQueueResults),
        ...buildBucketTasks(ctx, bucketHandlers, bucketResults),
        ...buildMailerTasks(ctx, mailerHandlers, mailerResults),
        ...buildCronTasks(ctx, cronHandlers, cronResults),
        ...buildWorkerTasks(ctx, workerHandlers, workerResults),
        ...buildMcpTasks(ctx, mcpHandlers, mcpResults),
      ];

      yield* Effect.all(phase1Tasks, { concurrency: DEPLOY_CONCURRENCY, discard: true });

      // Build map: API/MCP export name → Lambda Function URL domain
      const apiUrlMap = new Map<string, string>();
      for (const r of [...apiResults, ...mcpResults]) {
        apiUrlMap.set(r.exportName, r.url.replace("https://", "").replace(/\/$/, ""));
      }

      // Phase 2: Deploy app/site handlers with API origin map
      const phase2Tasks = [
        ...buildAppTasks(ctx, appHandlers, appResults, apiUrlMap),
        ...(noSites ? [] : buildStaticSiteTasks(ctx, staticSiteHandlers, staticSiteResults, apiUrlMap)),
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
        ...(noSites ? [] : buildStaticSiteTasks(ctx, staticSiteHandlers, staticSiteResults)),
        ...buildFifoQueueTasks(ctx, fifoQueueHandlers, fifoQueueResults),
        ...buildBucketTasks(ctx, bucketHandlers, bucketResults),
        ...buildMailerTasks(ctx, mailerHandlers, mailerResults),
        ...buildCronTasks(ctx, cronHandlers, cronResults),
        ...buildWorkerTasks(ctx, workerHandlers, workerResults),
        ...buildMcpTasks(ctx, mcpHandlers, mcpResults),
      ];

      yield* Effect.all(tasks, { concurrency: DEPLOY_CONCURRENCY, discard: true });
    }

    // Clean up orphaned CloudFront Functions
    if ((!noSites && staticSiteResults.length > 0) || appResults.length > 0) {
      yield* cleanupOrphanedFunctions(ctx.input.project, ctx.stage).pipe(
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

    return { tableResults, appResults, staticSiteResults, fifoQueueResults, bucketResults, mailerResults, cronResults, apiResults, mcpResults };
  });

// ---- Orchestrator ----

// ---- Dry-run: discover + bundle + validate, no AWS ----

const dryRunProject = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    startDeployLog();
    startBundleCollector();
    const stage = resolveStage(input.stage);
    logDeploy(`[dry-run] Starting for ${input.project} (stage: ${stage}, region: ${input.region})`);

    const { files, discovered, counts } = yield* discoverAndValidate(input);

    const countParts = (Object.entries(counts) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${n} ${type}`);
    logDeploy(`[dry-run] Discovered ${countParts.join(", ")} in ${files.length} file(s)`);

    // Map flattenHandlers type names to HandlerType (handlerRegistry keys)
    const bundleTypeMap: Record<string, HandlerType> = {
      table: "table", api: "api", cron: "cron", bucket: "bucket",
      mcp: "mcp", site: "staticSite", queue: "fifoQueue", worker: "worker",
    };
    // These handler types have no Lambda bundle
    const skipBundle = new Set(["app", "mailer"]);

    // Bundle all handlers (validates that code compiles)
    const allHandlers = flattenHandlers(discovered);
    const bundleResults: { name: string; type: string; size: number }[] = [];

    for (const h of allHandlers) {
      if (skipBundle.has(h.type)) {
        bundleResults.push({ name: h.exportName, type: h.type, size: 0 });
        logDeploy(`[dry-run] ${h.exportName} (${h.type}): skipped (no Lambda)`);
        continue;
      }
      const bundleType = bundleTypeMap[h.type];
      if (!bundleType) {
        logDeploy(`[dry-run] ${h.exportName} (${h.type}): skipped (unknown type)`);
        continue;
      }
      const result = yield* bundle({
        projectDir: input.projectDir,
        file: h.file,
        exportName: h.exportName,
        type: bundleType,
      });
      const size = Buffer.byteLength(result.code, "utf-8");
      bundleResults.push({ name: h.exportName, type: h.type, size });
      collectBundle(h.exportName, result.code);
      logDeploy(`[dry-run] ${h.exportName} (${h.type}): bundled ${formatBytes(size)}`);
    }

    // Print summary
    yield* Console.log(`\n${c.green(`Dry run: ${bundleResults.length} handler(s) validated`)}`);
    for (const r of bundleResults) {
      const sizeStr = r.size > 0 ? c.dim(formatBytes(r.size)) : c.dim("no bundle");
      yield* Console.log(`  ${c.cyan(`[${r.type}]`.padEnd(9))} ${c.bold(r.name)}  ${sizeStr}`);
    }

    logDeploy(`[dry-run] Complete: ${bundleResults.length} handler(s) bundled`);

    // Write state (bundles + log only, no deploy results)
    yield* writeDeployState({
      project: input.project,
      stage,
      region: input.region,
      projectDir: input.projectDir,
      results: {
        tableResults: [], appResults: [], staticSiteResults: [],
        fifoQueueResults: [], bucketResults: [], mailerResults: [],
        cronResults: [], apiResults: [], mcpResults: [],
      },
      logLines: flushDeployLog(),
      bundles: flushBundleCollector(),
    });

    return {
      tableResults: [], appResults: [], staticSiteResults: [],
      fifoQueueResults: [], bucketResults: [], mailerResults: [],
      cronResults: [], apiResults: [], mcpResults: [],
    } satisfies DeployProjectResult;
  });

export const deployProject = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    if (input.dryRun) {
      return yield* dryRunProject(input);
    }

    startDeployLog();
    startBundleCollector();
    logDeploy(`[deploy] Starting deploy for ${input.project} (region: ${input.region})`);

    const { stage, files, discovered, counts, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap, workerNameMap } =
      yield* discoverAndValidate(input);

    const countParts = (Object.entries(counts) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${n} ${type}`);
    logDeploy(`[deploy] Discovered ${countParts.join(", ")} in ${files.length} file(s)`);

    const { cfSigningInfo } = yield* prepareSecrets({
      discovered, project: input.project, stage, region: input.region, noSites: input.noSites,
    });

    const needsLambda = counts.table + counts.app + counts.queue + counts.bucket + counts.mailer + counts.api + counts.cron + counts.mcp > 0;
    const { layerArn, layerVersion, external } = yield* prepareLambdaLayer({
      project: input.project, stage, region: input.region, files, projectDir: input.projectDir, needsLambda,
    });

    if (layerArn) {
      logDeploy(`[layer] v${layerVersion} (${external.length} packages)`);
    }

    yield* Console.log("");

    const manifest = buildManifest(discovered, input.noSites);
    const logComplete = createLiveProgress(manifest, input.silent);

    const cfDomain = cfSigningInfo
      ? yield* resolveCfDomain({ staticSiteHandlers: discovered.staticSiteHandlers, project: input.project, stage })
      : undefined;

    const ctx: DeployTaskCtx = {
      input, layerArn, external, stage, tableNameMap, bucketNameMap, mailerDomainMap, queueNameMap, workerNameMap, logComplete,
      ...(cfSigningInfo ? { cfSigningInfo } : {}),
      ...(cfDomain ? { cfDomain } : {}),
    };

    const results = yield* deployResources({ ctx, discovered, counts });

    // Write deploy state to ~/.effortless-aws/<project>-<stage>/
    const totalHandlers = Object.keys(results).reduce(
      (sum, key) => sum + (results as any)[key].length, 0
    );
    logDeploy(`[deploy] Complete: ${totalHandlers} handler(s) deployed`);

    yield* writeDeployState({
      project: input.project,
      stage,
      region: input.region,
      projectDir: input.projectDir,
      results,
      layerArn,
      layerVersion,
      logLines: flushDeployLog(),
      bundles: flushBundleCollector(),
    });

    return results;
  });
