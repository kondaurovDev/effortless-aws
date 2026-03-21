import type { AnySecretRef, ResolveConfig, Duration, ConfigFactory, LogLevel, Permission } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";
import type { BucketClient } from "../runtime/bucket-client";

/**
 * Configuration options for defineBucket.
 */
export type BucketConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: { memory?: number; timeout?: Duration; logLevel?: LogLevel; permissions?: Permission[] };
  /** S3 key prefix filter for event notifications (e.g., "uploads/") */
  prefix?: string;
  /** S3 key suffix filter for event notifications (e.g., ".jpg") */
  suffix?: string;
};

/**
 * S3 event record passed to onObjectCreated/onObjectRemoved callbacks.
 */
export type BucketEvent = {
  /** S3 event name (e.g., "ObjectCreated:Put", "ObjectRemoved:Delete") */
  eventName: string;
  /** Object key (path within the bucket) */
  key: string;
  /** Object size in bytes (present for created events) */
  size?: number;
  /** Object ETag (present for created events) */
  eTag?: string;
  /** ISO 8601 timestamp of when the event occurred */
  eventTime?: string;
  /** S3 bucket name */
  bucketName: string;
};

// ============ Setup args ============

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

/** Setup factory — receives bucket/deps/config/files based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & { bucket: BucketClient }
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/**
 * Callback function type for S3 ObjectCreated events
 */
export type BucketObjectCreatedFn<C = undefined> =
  (args: { event: BucketEvent }
    & SpreadCtx<C>
  ) => Promise<void>;

/**
 * Callback function type for S3 ObjectRemoved events
 */
export type BucketObjectRemovedFn<C = undefined> =
  (args: { event: BucketEvent }
    & SpreadCtx<C>
  ) => Promise<void>;

// ============ Internal handler object ============

/**
 * Internal handler object created by defineBucket
 * @internal
 */
export type BucketHandler<C = any> = {
  readonly __brand: "effortless-bucket";
  readonly __spec: BucketConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onObjectCreated?: (...args: any[]) => any;
  readonly onObjectRemoved?: (...args: any[]) => any;
};

// ============ Builder options ============

/** Options passed to `defineBucket()` — static config */
type BucketOptions = {
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout (default: 30s) */
  timeout?: Duration;
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
  /** Logging verbosity */
  logLevel?: LogLevel;
  /** S3 key prefix filter for event notifications (e.g., "uploads/") */
  prefix?: string;
  /** S3 key suffix filter for event notifications (e.g., ".jpg") */
  suffix?: string;
  /** Static file glob patterns to bundle into the Lambda ZIP */
  static?: string[];
};

// ============ Builder ============

interface BucketBuilder<
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): BucketBuilder<D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): BucketBuilder<D, P2, C, HasFiles>;

  /** Initialize shared state on cold start. Receives bucket (self-client), deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>
  ): BucketBuilder<D, P, C2, HasFiles>;

  /** Handle errors thrown by callbacks */
  onError(
    fn: (args: { error: unknown } & SpreadCtx<C>) => void
  ): BucketBuilder<D, P, C, HasFiles>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): BucketBuilder<D, P, C, HasFiles>;

  /** Handle S3 ObjectCreated events (terminal — returns finalized handler) */
  onObjectCreated(
    fn: BucketObjectCreatedFn<C>
  ): BucketHandler<C>;

  /** Handle S3 ObjectRemoved events (terminal — returns finalized handler) */
  onObjectRemoved(
    fn: BucketObjectRemovedFn<C>
  ): BucketHandler<C>;

  /** Finalize as resource-only bucket (no Lambda) */
  build(): BucketHandler<C>;
}

// ============ Implementation ============

/**
 * Define an S3 bucket with optional event handlers.
 *
 * @example Bucket with event handler
 * ```typescript
 * export const uploads = defineBucket({ prefix: "images/", suffix: ".jpg" })
 *   .onObjectCreated(async ({ event, bucket }) => {
 *     console.log("New upload:", event.key);
 *   })
 *
 * ```
 *
 * @example Resource-only bucket (no Lambda)
 * ```typescript
 * export const assets = defineBucket().build()
 * ```
 */
export function defineBucket(): BucketBuilder;
export function defineBucket(
  options: BucketOptions & { static: string[] },
): BucketBuilder<undefined, undefined, undefined, true>;
export function defineBucket(
  options: BucketOptions,
): BucketBuilder;
export function defineBucket(
  options?: BucketOptions,
): BucketBuilder {
  const {
    memory, timeout, permissions, logLevel,
    static: staticFiles,
    ...bucketConfig
  } = options ?? {} as BucketOptions;

  const hasLambda = memory != null || timeout != null || permissions != null || logLevel != null;
  const spec: BucketConfig = {
    ...bucketConfig,
    ...(hasLambda ? { lambda: { ...(memory != null ? { memory } : {}), ...(timeout != null ? { timeout } : {}), ...(permissions ? { permissions } : {}), ...(logLevel ? { logLevel } : {}) } } : {}),
  };

  const state: {
    spec: BucketConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    onObjectCreated?: (...args: any[]) => any;
    onObjectRemoved?: (...args: any[]) => any;
  } = {
    spec,
    ...(staticFiles ? { static: staticFiles } : {}),
  };

  const finalize = (): BucketHandler => ({
    __brand: "effortless-bucket",
    __spec: state.spec,
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.onObjectCreated ? { onObjectCreated: state.onObjectCreated } : {}),
    ...(state.onObjectRemoved ? { onObjectRemoved: state.onObjectRemoved } : {}),
  }) as BucketHandler;

  const builder: BucketBuilder = {
    deps(fn) {
      state.deps = fn as any;
      return builder as any;
    },
    config(fn) {
      state.config = resolveConfigFactory(fn) as any;
      return builder as any;
    },
    setup(fn) {
      state.setup = fn as any;
      return builder as any;
    },
    onObjectCreated(fn) {
      state.onObjectCreated = fn as any;
      return finalize() as any;
    },
    onObjectRemoved(fn) {
      state.onObjectRemoved = fn as any;
      return finalize() as any;
    },
    onError(fn) {
      state.onError = fn as any;
      return builder as any;
    },
    onCleanup(fn) {
      state.onCleanup = fn as any;
      return builder as any;
    },
    build() {
      return finalize() as any;
    },
  };

  return builder;
}
