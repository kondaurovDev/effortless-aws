/**
 * defineProject — single entry point for declaring all infrastructure in effortless.config.ts.
 *
 * Replaces defineConfig + define* in handler files with one config file that describes
 * all resources, their connections (link), and handler file paths.
 */

import type { Duration, LambdaWithPermissions, GenerateSpec, Permission } from "./handlers/handler-options";
import type { StreamView } from "./handlers/define-table";
import type { ScheduleExpression } from "./handlers/define-cron";
import type { Timezone } from "./handlers/timezone";

// ============ Resource types ============

export type ProjectTable = {
  readonly __type: "table";
  /** Path to handler file for DynamoDB stream processing (e.g. "./handlers/orders/stream.ts") */
  handler?: string;
  /** References to other resources in the project */
  link?: string[];
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  streamView?: StreamView;
  batchSize?: number;
  batchWindow?: Duration;
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  concurrency?: number;
  lambda?: LambdaWithPermissions;
};

export type ProjectApi = {
  readonly __type: "api";
  /** URL base path (must start with /) */
  basePath: `/${string}`;
  /** Path to handler file (e.g. "./handlers/orders/api.ts") — required */
  handler: string;
  /** References to other resources in the project */
  link?: string[];
  stream?: boolean;
  lambda?: LambdaWithPermissions;
};

export type ProjectBucket = {
  readonly __type: "bucket";
  /** Path to handler file for S3 events (e.g. "./handlers/uploads/on-upload.ts") */
  handler?: string;
  /** References to other resources in the project */
  link?: string[];
  prefix?: string;
  suffix?: string;
  seed?: string;
  sync?: string;
  lambda?: LambdaWithPermissions;
};

export type ProjectCron = {
  readonly __type: "cron";
  /** Schedule expression: "rate(5 minutes)" or "cron(0 9 * * ? *)" */
  schedule: ScheduleExpression;
  /** Path to handler file (e.g. "./handlers/cleanup.ts") — required */
  handler: string;
  /** References to other resources in the project */
  link?: string[];
  timezone?: Timezone;
  lambda?: LambdaWithPermissions;
};

export type ProjectQueue = {
  readonly __type: "queue";
  /** Path to handler file for SQS message processing */
  handler?: string;
  /** References to other resources in the project */
  link?: string[];
  batchSize?: number;
  batchWindow?: Duration;
  visibilityTimeout?: Duration;
  retentionPeriod?: Duration;
  delay?: Duration;
  contentBasedDeduplication?: boolean;
  maxReceiveCount?: number;
  lambda?: LambdaWithPermissions;
};

export type ProjectWorker = {
  readonly __type: "worker";
  /** Path to handler file for worker messages */
  handler?: string;
  /** References to other resources in the project */
  link?: string[];
  size?: "0.25vCPU-512mb" | "0.5vCPU-1gb" | "1vCPU-2gb" | "2vCPU-4gb" | "4vCPU-8gb";
  idleTimeout?: Duration;
  concurrency?: number;
  lambda?: LambdaWithPermissions;
};

export type ProjectMailer = {
  readonly __type: "mailer";
  /** Email domain for SES identity */
  domain: string;
};

export type ProjectSecret = {
  readonly __type: "secret";
  /** Custom SSM parameter name (default: derived from resource key) */
  key?: string;
  /** Auto-generate the secret at deploy time */
  generate?: GenerateSpec;
};

/** Union of all project resource types */
export type ProjectResource =
  | ProjectTable
  | ProjectApi
  | ProjectBucket
  | ProjectCron
  | ProjectQueue
  | ProjectWorker
  | ProjectMailer
  | ProjectSecret;

// ============ Helpers injected into factory ============

type TableOptions = Omit<ProjectTable, "__type">;
type ApiOptions = Omit<ProjectApi, "__type">;
type BucketOptions = Omit<ProjectBucket, "__type">;
type CronOptions = Omit<ProjectCron, "__type">;
type QueueOptions = Omit<ProjectQueue, "__type">;
type WorkerOptions = Omit<ProjectWorker, "__type">;
type MailerOptions = Omit<ProjectMailer, "__type">;
type SecretOptions = Omit<ProjectSecret, "__type">;

export type ProjectHelpers = {
  table: (opts?: TableOptions) => ProjectTable;
  api: (opts: ApiOptions) => ProjectApi;
  bucket: (opts?: BucketOptions) => ProjectBucket;
  cron: (opts: CronOptions) => ProjectCron;
  queue: (opts?: QueueOptions) => ProjectQueue;
  worker: (opts?: WorkerOptions) => ProjectWorker;
  mailer: (opts: MailerOptions) => ProjectMailer;
  secret: (opts?: SecretOptions) => ProjectSecret;
};

// ============ Project definition & manifest ============

/** Global Lambda defaults */
export type GlobalLambdaConfig = {
  memory?: number;
  timeout?: string;
  runtime?: string;
};

/** What the user's factory function returns */
export type ProjectDefinition = {
  name: string;
  region?: string;
  stage?: string;
  lambda?: GlobalLambdaConfig;
  [key: string]: ProjectResource | GlobalLambdaConfig | string | undefined;
};

/** Sealed manifest returned by defineProject, consumed by the CLI */
export type ProjectManifest = {
  readonly __brand: "effortless-project";
  readonly name: string;
  readonly region?: string;
  readonly stage?: string;
  readonly lambda?: GlobalLambdaConfig;
  readonly resources: Record<string, ProjectResource>;
};

// ============ Helpers implementation ============

const KNOWN_KEYS = new Set(["name", "region", "stage", "lambda"]);

const isResource = (value: unknown): value is ProjectResource =>
  typeof value === "object" && value !== null && "__type" in value;

const helpers: ProjectHelpers = {
  table: (opts?: TableOptions): ProjectTable => ({ __type: "table", ...opts }),
  api: (opts: ApiOptions): ProjectApi => ({ __type: "api", ...opts }),
  bucket: (opts?: BucketOptions): ProjectBucket => ({ __type: "bucket", ...opts }),
  cron: (opts: CronOptions): ProjectCron => ({ __type: "cron", ...opts }),
  queue: (opts?: QueueOptions): ProjectQueue => ({ __type: "queue", ...opts }),
  worker: (opts?: WorkerOptions): ProjectWorker => ({ __type: "worker", ...opts }),
  mailer: (opts: MailerOptions): ProjectMailer => ({ __type: "mailer", ...opts }),
  secret: (opts?: SecretOptions): ProjectSecret => ({ __type: "secret", ...opts }),
};

// ============ defineProject ============

/**
 * Define a complete project — infrastructure, resources, and handler references — in one place.
 *
 * @example
 * ```typescript
 * import { defineProject } from "effortless-aws";
 *
 * export default defineProject(({ table, api, bucket, secret }) => ({
 *   name: "my-service",
 *   region: "eu-central-1",
 *
 *   orders: table({ billingMode: "PAY_PER_REQUEST" }),
 *   uploads: bucket(),
 *   stripeKey: secret(),
 *
 *   ordersApi: api({
 *     basePath: "/orders",
 *     handler: "./handlers/orders/api.ts",
 *     link: ["orders", "uploads", "stripeKey"],
 *   }),
 * }));
 * ```
 */
export const defineProject = (
  factory: (helpers: ProjectHelpers) => ProjectDefinition,
): ProjectManifest => {
  const definition = factory(helpers);

  // Extract known config fields
  const { name, region, stage, lambda } = definition;
  if (!name || typeof name !== "string") {
    throw new Error("defineProject: 'name' is required and must be a string");
  }

  // Extract resources (everything with __type)
  const resources: Record<string, ProjectResource> = {};
  for (const [key, value] of Object.entries(definition)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (isResource(value)) {
      resources[key] = value;
    }
  }

  // Validate link references
  for (const [key, resource] of Object.entries(resources)) {
    if ("link" in resource && resource.link) {
      for (const linkName of resource.link) {
        if (!resources[linkName]) {
          throw new Error(
            `defineProject: resource "${key}" links to "${linkName}", but no resource with that name exists. ` +
            `Available resources: ${Object.keys(resources).join(", ")}`,
          );
        }
      }
    }
  }

  return {
    __brand: "effortless-project",
    name,
    region,
    stage,
    lambda,
    resources,
  };
};
