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
  /** Handler name. Defaults to export name if not specified */
  name?: string;
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
 * // Before (breaks inference for setup, deps, config):
 * export const users = defineTable<User>({ pk: { name: "id", type: "string" } });
 *
 * // After (all generics inferred correctly):
 * export const users = defineTable({
 *   pk: { name: "id", type: "string" },
 *   schema: typed<User>(),
 * });
 * ```
 *
 * @example Table with stream handler
 * ```typescript
 * export const orders = defineTable({
 *   pk: { name: "id", type: "string" },
 *   schema: typed<Order>(),
 *   setup: async () => ({ db: createClient() }),
 *   onRecord: async ({ record, ctx }) => {
 *     // record.new is Order, ctx is { db: Client } — all inferred
 *   },
 * });
 * ```
 */
export function typed<T>(): (input: unknown) => T {
  return (input: unknown) => input as T;
}
