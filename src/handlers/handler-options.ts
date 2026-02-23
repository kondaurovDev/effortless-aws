// Public helpers — this file must have ZERO heavy imports (no effect, no AWS SDK, no deploy code).
// It is the source of truth for param(), typed(), and related types used by the public API.

// ============ Permissions ============

type AwsService =
  | "dynamodb"
  | "s3"
  | "sqs"
  | "sns"
  | "ses"
  | "ssm"
  | "lambda"
  | "events"
  | "secretsmanager"
  | "cognito-idp"
  | "logs";

export type Permission = `${AwsService}:${string}` | (string & {});

// ============ Lambda config ============

/** Logging verbosity level for Lambda handlers */
export type LogLevel = "error" | "info" | "debug";

/**
 * Common Lambda configuration shared by all handler types.
 */
export type LambdaConfig = {
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout in seconds (default: 30) */
  timeout?: number;
  /** Logging verbosity: "error" (errors only), "info" (+ execution summary), "debug" (+ input/output). Default: "info" */
  logLevel?: LogLevel;
};

/**
 * Lambda configuration with additional IAM permissions.
 * Used by handler types that support custom permissions (http, table, fifo-queue).
 */
export type LambdaWithPermissions = LambdaConfig & {
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
};

// ============ Params ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyParamRef = ParamRef<any> | string;

/**
 * Reference to an SSM Parameter Store parameter.
 *
 * @typeParam T - The resolved type after optional transform (default: string)
 */
export type ParamRef<T = string> = {
  readonly __brand: "effortless-param";
  readonly key: string;
  readonly transform?: (raw: string) => T;
};

/**
 * Maps a config declaration to resolved value types.
 * Plain strings resolve to `string`, `ParamRef<T>` resolves to `T`.
 *
 * @typeParam P - Record of config keys to string or ParamRef instances
 */
export type ResolveConfig<P> = {
  [K in keyof P]: P[K] extends ParamRef<infer T> ? T : string;
};

/**
 * Declare an SSM Parameter Store parameter.
 *
 * The key is combined with project and stage at deploy time to form the full
 * SSM path: `/${project}/${stage}/${key}`.
 *
 * @param key - Parameter key (e.g., "database-url")
 * @param transform - Optional function to transform the raw string value
 * @returns A ParamRef used by the deployment and runtime systems
 *
 * @example Simple string parameter
 * ```typescript
 * config: {
 *   dbUrl: param("database-url"),
 * }
 * ```
 *
 * @example With transform (e.g., TOML parsing)
 * ```typescript
 * import TOML from "smol-toml";
 *
 * config: {
 *   appConfig: param("app-config", TOML.parse),
 * }
 * ```
 */
export function param(key: string): ParamRef<string>;
export function param<T>(key: string, transform: (raw: string) => T): ParamRef<T>;
export function param<T = string>(
  key: string,
  transform?: (raw: string) => T
): ParamRef<T> {
  return {
    __brand: "effortless-param",
    key,
    ...(transform ? { transform } : {}),
  } as ParamRef<T>;
}

// ============ Single-table types ============

/**
 * DynamoDB table key (always pk + sk strings in single-table design).
 */
export type TableKey = { pk: string; sk: string };

/**
 * Full DynamoDB item in the single-table design.
 *
 * Every item has a fixed envelope: `pk`, `sk`, `tag`, `data`, and optional `ttl`.
 * `tag` is stored as a top-level DynamoDB attribute (GSI-ready).
 * If your domain type `T` includes a `tag` field, effortless auto-copies
 * `data.tag` to the top-level `tag` on `put()`, so you don't have to pass it twice.
 *
 * @typeParam T - The domain data type stored in the `data` attribute
 */
export type TableItem<T> = {
  pk: string;
  sk: string;
  tag: string;
  data: T;
  ttl?: number;
};

/**
 * Input type for `TableClient.put()`.
 *
 * Unlike `TableItem<T>`, this does NOT include `tag` — effortless auto-extracts
 * the top-level DynamoDB `tag` attribute from your data using the configured
 * tag field (defaults to `data.tag`, configurable via `defineTable({ tag: "type" })`).
 *
 * @typeParam T - The domain data type stored in the `data` attribute
 */
export type PutInput<T> = {
  pk: string;
  sk: string;
  data: T;
  ttl?: number;
};

// ============ Typed helper ============

/**
 * Type-only schema helper for handlers.
 *
 * Use this instead of explicit generic parameters like `defineTable<Order>(...)`.
 * It enables TypeScript to infer all generic types from the options object,
 * avoiding the partial-inference problem where specifying one generic
 * forces all others to their defaults.
 *
 * At runtime this is a no-op identity function — it simply returns the input unchanged.
 * The type narrowing happens entirely at the TypeScript level.
 *
 * @example Resource-only table
 * ```typescript
 * type User = { id: string; email: string };
 *
 * export const users = defineTable({
 *   schema: typed<User>(),
 * });
 * ```
 *
 * @example Table with stream handler
 * ```typescript
 * export const orders = defineTable({
 *   schema: typed<Order>(),
 *   setup: async () => ({ db: createClient() }),
 *   onRecord: async ({ record, ctx }) => {
 *     // record.new.data is Order, ctx is { db: Client } — all inferred
 *   },
 * });
 * ```
 */
export function typed<T>(): (input: unknown) => T {
  return (input: unknown) => input as T;
}
