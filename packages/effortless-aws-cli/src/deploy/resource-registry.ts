/**
 * Resource Registry — single source of truth for what AWS resources
 * each handler type creates and how to clean them up.
 *
 * Every resource created during deploy MUST be listed here.
 * If it's not in the registry, it won't be cleaned up.
 *
 * Cleanup is name-based (not tag-based): we derive the resource name
 * from the deterministic naming convention {project}-{stage}-{handler},
 * then call the delete function directly. This avoids relying on the
 * Resource Groups Tagging API which has gaps (no Scheduler support,
 * indexing delays, etc.).
 */

import { Effect } from "effect";
import { DeployContext } from "../core";
import {
  deleteLambda,
  deleteRole,
  deleteTable,
  deleteBucket,
  disableAndDeleteDistribution,
  deleteFifoQueue,
  deleteStandardQueue,
  deleteSesIdentity,
  deleteSchedule,
  deleteEcsService,
  deleteEcsCluster,
  deregisterTaskDefinitions,
  deleteLogGroup,
} from "../aws";
import { findHandlerResourceArns } from "../aws/resource-lookup";
import type { ResourceType, HandlerType } from "../core";
export type { HandlerType } from "../core";

// ============ Types ============

export type NameCtx = { project: string; stage: string; handler: string; region: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CleanupFn = (ctx: NameCtx) => Effect.Effect<void, any, any>;

export type ResourceSpec = {
  /** AWS resource type (for display/categorization) */
  type: ResourceType;
  /** Human-readable label for logs/status */
  label: string;
  /** Lower number = deleted first */
  cleanupOrder: number;
  /** Derive the resource name from project/stage/handler */
  deriveName: (ctx: NameCtx) => string;
  /** Function to delete this resource by derived name */
  cleanup: CleanupFn;
  /** If true, skip when deleting individual handlers (only delete on full teardown) */
  shared?: boolean;
};

// ============ Cleanup order constants ============

const ORDER = {
  ECS_SERVICE: 10,
  LAMBDA: 20,
  SCHEDULER: 30,
  SQS: 40,
  CLOUDFRONT: 50,
  SES: 60,
  DYNAMODB: 70,
  S3: 80,
  ECS_TASK: 85,
  LOGS: 90,
  ECS_CLUSTER: 100,
  LAMBDA_LAYER: 120,
  IAM_ROLE: 130,
} as const;

// ============ Shorthand name derivations ============

/** {project}-{stage}-{handler} */
const std = (ctx: NameCtx) => `${ctx.project}-${ctx.stage}-${ctx.handler}`;

// ============ Tag-based cleanup helpers ============
// For resources whose names can't be derived from naming convention.

/** Find and delete CloudFront distribution by handler tags */
const deleteCloudFrontByTag = (ctx: NameCtx) =>
  Effect.gen(function* () {
    const arns = yield* findHandlerResourceArns(ctx.handler, "arn:aws:cloudfront:");
    for (const arn of arns) {
      const distributionId = arn.split("/").pop()!;
      yield* disableAndDeleteDistribution(distributionId);
    }
  });

/** Find and delete SES identity by handler tags */
const deleteSesByTag = (ctx: NameCtx) =>
  Effect.gen(function* () {
    const arns = yield* findHandlerResourceArns(ctx.handler, "arn:aws:ses:");
    for (const arn of arns) {
      const identity = arn.split("/").pop()!;
      yield* deleteSesIdentity(identity);
    }
  });

// ============ Registry ============

/**
 * Maps each handler type to the AWS resources it creates.
 *
 * To add a new handler type:
 * 1. Add a new entry to this map
 * 2. List ALL resources the deploy function creates
 * 3. Provide deriveName + cleanup for each
 */
export const HANDLER_RESOURCES: Record<HandlerType, ResourceSpec[]> = {
  // ── defineTable ─────────────────────────────────────────
  // deployCoreLambda → Lambda + IAM Role
  // ensureTable → DynamoDB Table
  // ensureEventSourceMapping → managed by Lambda, no separate cleanup
  table: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "dynamodb", label: "DynamoDB Table", cleanupOrder: ORDER.DYNAMODB, deriveName: std, cleanup: (c) => deleteTable(std(c)) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],

  // ── defineApi ───────────────────────────────────────────
  // deployCoreLambda → Lambda + IAM Role
  // ensureFunctionUrl → sub-resource of Lambda
  api: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],

  // ── defineCron ──────────────────────────────────────────
  // deployCoreLambda → Lambda + IAM Role
  // ensureSchedulerRole → Scheduler IAM Role
  // ensureSchedule → EventBridge Schedule
  cron: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "scheduler", label: "EventBridge Schedule", cleanupOrder: ORDER.SCHEDULER, deriveName: std, cleanup: (c) => deleteSchedule(std(c)) },
    { type: "iam-role", label: "Lambda IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
    { type: "iam-role", label: "Scheduler IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-scheduler-role`, cleanup: (c) => deleteRole(`${std(c)}-scheduler-role`) },
  ],

  // ── defineFifoQueue ────────────────────────────────────
  // deployCoreLambda → Lambda + IAM Role
  // ensureFifoQueue → SQS FIFO Queue + DLQ
  fifoQueue: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "sqs", label: "SQS FIFO Queue + DLQ", cleanupOrder: ORDER.SQS, deriveName: std, cleanup: (c) => deleteFifoQueue(std(c)) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],

  // ── defineBucket ───────────────────────────────────────
  // ensureBucket → S3 Bucket
  // deployCoreLambda → Lambda + IAM Role (only if handler exists)
  bucket: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "s3-bucket", label: "S3 Bucket", cleanupOrder: ORDER.S3, deriveName: (c) => std(c).toLowerCase(), cleanup: (c) => deleteBucket(std(c).toLowerCase()) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],

  // ── defineMailer ───────────────────────────────────────
  // ensureSesIdentity → SES Domain Identity
  // NOTE: SES identity name is the domain (from config), not derivable from handler name.
  // Mailer cleanup relies on tag-based discovery for the domain name.
  mailer: [
    { type: "ses", label: "SES Identity", cleanupOrder: ORDER.SES, deriveName: () => "(by tag)", cleanup: deleteSesByTag },
  ],

  // ── defineStaticSite ───────────────────────────────────
  // ensureBucket → S3 Bucket ({project}-{stage}-{handler}-site)
  // ensureDistribution → CloudFront Distribution (discovered by tag)
  // deployMiddlewareLambda → Lambda@Edge + IAM Role (if middleware)
  staticSite: [
    { type: "lambda", label: "Lambda@Edge", cleanupOrder: ORDER.LAMBDA, deriveName: (c) => `${std(c)}-middleware`, cleanup: (c) => deleteLambda(`${std(c)}-middleware`) },
    { type: "cloudfront-distribution", label: "CloudFront Distribution", cleanupOrder: ORDER.CLOUDFRONT, deriveName: () => "(by tag)", cleanup: deleteCloudFrontByTag },
    { type: "s3-bucket", label: "S3 Bucket", cleanupOrder: ORDER.S3, deriveName: (c) => `${std(c)}-site`, cleanup: (c) => deleteBucket(`${std(c)}-site`) },
    { type: "iam-role", label: "Edge IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-middleware-role`, cleanup: (c) => deleteRole(`${std(c)}-middleware-role`) },
  ],

  // ── defineApp ──────────────────────────────────────────
  // ensureRole + ensureLambda → Lambda + IAM Role
  // ensureFunctionUrl → sub-resource
  // ensureBucket → S3 Bucket ({project}-{stage}-{handler}-assets)
  // ensureSsrDistribution → CloudFront Distribution (discovered by tag)
  app: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "cloudfront-distribution", label: "CloudFront Distribution", cleanupOrder: ORDER.CLOUDFRONT, deriveName: () => "(by tag)", cleanup: deleteCloudFrontByTag },
    { type: "s3-bucket", label: "S3 Bucket", cleanupOrder: ORDER.S3, deriveName: (c) => `${std(c)}-assets`, cleanup: (c) => deleteBucket(`${std(c)}-assets`) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],

  // ── defineWorker ───────────────────────────────────────
  // SQS standard queue, S3 code bucket, CloudWatch Log Group,
  // ECS Cluster + Service + Task Definition, IAM Roles (task + execution)
  worker: [
    { type: "ecs", label: "ECS Service", cleanupOrder: ORDER.ECS_SERVICE, deriveName: std, cleanup: (c) => deleteEcsService(`${c.project}-${c.stage}`, std(c)) },
    { type: "sqs", label: "SQS Queue", cleanupOrder: ORDER.SQS, deriveName: (c) => `${std(c)}-worker`, cleanup: (c) => deleteStandardQueue(`${std(c)}-worker`) },
    { type: "ecs", label: "ECS Task Definition", cleanupOrder: ORDER.ECS_TASK, deriveName: std, cleanup: (c) => deregisterTaskDefinitions(std(c)) },
    { type: "logs", label: "CloudWatch Logs", cleanupOrder: ORDER.LOGS, deriveName: (c) => `/ecs/${std(c)}`, cleanup: (c) => deleteLogGroup(`/ecs/${std(c)}`) },
    { type: "s3-bucket", label: "S3 Bucket (code)", cleanupOrder: ORDER.S3, deriveName: (c) => `${c.project}-${c.stage}-effortless`, cleanup: (c) => deleteBucket(`${c.project}-${c.stage}-effortless`), shared: true },
    { type: "ecs", label: "ECS Cluster", cleanupOrder: ORDER.ECS_CLUSTER, deriveName: (c) => `${c.project}-${c.stage}`, cleanup: (c) => deleteEcsCluster(`${c.project}-${c.stage}`), shared: true },
    { type: "iam-role", label: "Task IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-task-role`, cleanup: (c) => deleteRole(`${std(c)}-task-role`) },
    { type: "iam-role", label: "Execution IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${c.project}-${c.stage}-ecs-execution-role`, cleanup: (c) => deleteRole(`${c.project}-${c.stage}-ecs-execution-role`), shared: true },
  ],

  // ── defineMcp ─────────────────────────────────────────
  // deployCoreLambda → Lambda + IAM Role
  // ensureFunctionUrl → sub-resource of Lambda
  mcp: [
    { type: "lambda", label: "Lambda", cleanupOrder: ORDER.LAMBDA, deriveName: std, cleanup: (c) => deleteLambda(std(c)) },
    { type: "iam-role", label: "IAM Role", cleanupOrder: ORDER.IAM_ROLE, deriveName: (c) => `${std(c)}-role`, cleanup: (c) => deleteRole(`${std(c)}-role`) },
  ],
};

// ============ Name-based cleanup ============

/**
 * Delete all resources for a handler using name-based lookup.
 * No dependency on tagging API — derives names from naming convention.
 */
/** Build a NameCtx from DeployContext + handler name. */
export const makeNameCtx = (handler: string) =>
  Effect.map(DeployContext, ({ project, stage, region }): NameCtx => ({ project, stage, handler, region }));

export const deleteHandlerResources = (
  handlerType: HandlerType,
  handler: string,
  options?: { skipShared?: boolean },
) =>
  Effect.gen(function* () {
    const ctx = yield* makeNameCtx(handler);
    const specs = HANDLER_RESOURCES[handlerType];
    const sorted = [...specs].sort((a, b) => a.cleanupOrder - b.cleanupOrder);

    for (const spec of sorted) {
      if (options?.skipShared && spec.shared) continue;

      const name = spec.deriveName(ctx);
      yield* Effect.logDebug(`Deleting ${spec.label}: ${name}`);
      yield* spec.cleanup(ctx).pipe(
        Effect.catchAll(error =>
          Effect.logDebug(`${spec.label} "${name}" not found or already deleted: ${error}`)
        )
      );
    }
  });

// ============ Utilities ============

/**
 * Get all resource types that a handler type creates.
 */
export const getResourceTypes = (handlerType: HandlerType): ResourceType[] =>
  HANDLER_RESOURCES[handlerType].map(spec => spec.type);

/**
 * Get human-readable resource summary for a handler type.
 */
export const getResourceSummary = (handlerType: HandlerType): string[] =>
  HANDLER_RESOURCES[handlerType].map(spec => spec.label);
