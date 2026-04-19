// Public helpers — this file must have ZERO heavy imports (no effect, no AWS SDK, no deploy code).
// It is the source of truth for param() and related types used by the public API.

// ============ Generate spec ============

/** Generator spec for auto-creating secrets at deploy time. */
export type GenerateSpec = `hex:${number}` | `base64:${number}` | "uuid";

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

// ============ Duration ============

/**
 * Human-readable duration. Accepts a plain number (seconds) or a string
 * with a unit suffix: `"30s"`, `"5m"`, `"1h"`, `"2d"`.
 *
 * @example
 * ```typescript
 * timeout: 30        // 30 seconds
 * timeout: "30s"     // 30 seconds
 * timeout: "5m"      // 300 seconds
 * timeout: "1h"      // 3600 seconds
 * retentionPeriod: "4d"  // 345600 seconds
 * ```
 */
export type Duration = number | `${number}s` | `${number}m` | `${number}h` | `${number}d`;

/** Convert a Duration to seconds. */
export const toSeconds = (d: Duration): number => {
  if (typeof d === "number") return d;
  const match = d.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: "${d}"`);
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === "d") return n * 86400;
  if (unit === "h") return n * 3600;
  if (unit === "m") return n * 60;
  return n;
};

// ============ Lambda config ============

/** Logging verbosity level for Lambda handlers */
export type LogLevel = "error" | "info" | "debug";

/**
 * Common Lambda configuration shared by all handler types.
 */
export type LambdaConfig = {
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout (default: 30s). Accepts seconds or duration string: `"30s"`, `"5m"` */
  timeout?: Duration;
  /** Logging verbosity: "error" (errors only), "info" (+ execution summary), "debug" (+ input/output). Default: "info" */
  logLevel?: LogLevel;
};

/**
 * Lambda configuration with additional IAM permissions.
 * Used by handler types that support custom permissions (http, table, queue).
 */
export type LambdaWithPermissions = LambdaConfig & {
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
};

// ============ Lambda options (for .setup()) ============

/**
 * Lambda configuration passed as argument to `.setup()`.
 * Common across all handler types that create a Lambda function.
 */
export type LambdaOptions = {
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout (default: 30s). Accepts seconds or duration string: `"30s"`, `"5m"` */
  timeout?: Duration;
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
  /** Logging verbosity: "error" (errors only), "info" (+ execution summary), "debug" (+ input/output). Default: "info" */
  logLevel?: LogLevel;
};

// ============ Secrets (SSM Parameters) ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySecretRef = SecretRef<any>;

/**
 * Reference to an SSM Parameter Store secret.
 *
 * @typeParam T - The resolved type after optional transform (default: string)
 */
export type SecretRef<T = string> = {
  readonly __brand: "effortless-secret";
  readonly key?: string;
  readonly generate?: GenerateSpec;
  readonly transform?: (raw: string) => T;
};

/**
 * Maps a config declaration to resolved value types.
 * `SecretRef<T>` resolves to `T`.
 *
 * @typeParam P - Record of config keys to SecretRef instances
 */
export type ResolveConfig<P> = {
  [K in keyof P]: P[K] extends SecretRef<infer T> ? T : string;
};

/** Options for `defineSecret()` without a transform. */
export type DefineSecretOptions = {
  /** Custom SSM key (default: derived from config property name in kebab-case) */
  key?: string;
  /** Generator spec for auto-creating the secret at deploy time: `"hex:32"`, `"base64:32"`, `"uuid"` */
  generate?: GenerateSpec;
};

/** Options for `defineSecret()` with a transform. */
export type DefineSecretOptionsWithTransform<T> = DefineSecretOptions & {
  /** Transform the raw SSM string value into a typed value */
  transform: (raw: string) => T;
};

/** The defineSecret helper function type, injected into config callbacks. */
export type DefineSecretFn = {
  (): SecretRef<string>;
  (options: DefineSecretOptions): SecretRef<string>;
  <T>(options: DefineSecretOptionsWithTransform<T>): SecretRef<T>;
};

/** Helpers injected into the `config` callback. */
export type ConfigHelpers = {
  defineSecret: DefineSecretFn;
};

/** Config factory: a function receiving helpers and returning a record of SecretRefs. */
export type ConfigFactory<P> = (helpers: ConfigHelpers) => P;

/** The `defineSecret` implementation, passed to config callbacks. */
export const defineSecret: DefineSecretFn = <T = string>(
  options?: DefineSecretOptions | DefineSecretOptionsWithTransform<T>
): SecretRef<T> => {
  return {
    __brand: "effortless-secret",
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.generate ? { generate: options.generate } : {}),
    ...("transform" in (options ?? {}) ? { transform: (options as DefineSecretOptionsWithTransform<T>).transform } : {}),
  } as SecretRef<T>;
};

/** Internal helpers object passed to config callbacks. */
export const configHelpers: ConfigHelpers = { defineSecret };

/** Resolve a config factory to a plain record of SecretRefs. */
export const resolveConfigFactory = <P>(config: ConfigFactory<P>): P =>
  config(configHelpers);

// ============ Backwards compatibility ============

/** @deprecated Use `defineSecret()` inside a config callback instead. */
export const secret = defineSecret;
/** @deprecated Use `SecretRef` instead */
export type ParamRef<T = string> = SecretRef<T>;
/** @deprecated Use `AnySecretRef` instead */
export type AnyParamRef = AnySecretRef;
/** @deprecated Use `defineSecret()` instead. */
export const param = <T = string>(key: string, transform?: (raw: string) => T): SecretRef<T> => {
  return {
    __brand: "effortless-secret",
    key,
    ...(transform ? { transform } : {}),
  } as SecretRef<T>;
};
/** @deprecated Use `defineSecret({ generate: "hex:N" })` instead. */
export const generateHex = (bytes: number) => `hex:${bytes}`;
/** @deprecated Use `defineSecret({ generate: "base64:N" })` instead. */
export const generateBase64 = (bytes: number) => `base64:${bytes}`;
/** @deprecated Use `defineSecret({ generate: "uuid" })` instead. */
export const generateUuid = () => "uuid";

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

