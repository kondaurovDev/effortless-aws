import type { AnySecretRef, ResolveConfig, Duration, ConfigFactory, LambdaOptions } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";
import type { BucketClient, BucketClientWithEntities } from "../runtime/bucket-client";

/**
 * Per-entity configuration for typed JSON key-value storage within a bucket.
 */
export type BucketEntityConfig = {
  /** Cache duration for CloudFront/browser caching (e.g., "10s", "5m", "1h"). No caching if omitted. */
  cache?: Duration;
};

/**
 * Configuration options for defineBucket.
 */
export type BucketConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: { memory?: number; timeout?: import("./handler-options").Duration; logLevel?: import("./handler-options").LogLevel; permissions?: import("./handler-options").Permission[] };
  /** S3 key prefix filter for event notifications (e.g., "uploads/") */
  prefix?: string;
  /** S3 key suffix filter for event notifications (e.g., ".jpg") */
  suffix?: string;
  /** Typed JSON entity definitions for key-value storage */
  entities?: Record<string, BucketEntityConfig>;
  /** Local directory to seed into bucket on deploy (only uploads files that don't already exist) */
  seed?: string;
  /** Local directory to sync into bucket on every deploy (uploads new/changed, deletes removed) */
  sync?: string;
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
type SetupArgs<D, P, HasFiles extends boolean, Entities extends Record<string, any> = {}> =
  & { bucket: {} extends Entities ? BucketClient : BucketClientWithEntities<Entities> }
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
export type BucketHandler<C = any, _Entities extends Record<string, any> = {}> = {
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
  /** S3 key prefix filter for event notifications (e.g., "uploads/") */
  prefix?: string;
  /** S3 key suffix filter for event notifications (e.g., ".jpg") */
  suffix?: string;
  /** Local directory to seed into bucket on deploy (only uploads files that don't already exist) */
  seed?: string;
  /** Local directory to sync into bucket on every deploy (uploads new/changed, deletes removed) */
  sync?: string;
};

// ============ Builder ============

interface BucketBuilder<
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
  Entities extends Record<string, any> = {},
> {
  /** Declare handler dependencies */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): BucketBuilder<D2, P, C, HasFiles, Entities>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): BucketBuilder<D, P2, C, HasFiles, Entities>;

  /** Include static files in the Lambda ZIP */
  include(glob: string): BucketBuilder<D, P, C, true, Entities>;

  /** Register a typed JSON entity stored as `{name}/{id}.json` in the bucket */
  entity<N extends string, T>(
    name: N,
    options?: BucketEntityConfig,
  ): BucketBuilder<D, P, C, HasFiles, Entities & { [K in N]: T }>;

  /** Initialize shared state on cold start with lambda options */
  setup(lambda: LambdaOptions): BucketBuilder<D, P, C, HasFiles, Entities>;
  /** Initialize shared state on cold start. Receives bucket (self-client), deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles, Entities>) => C2 | Promise<C2>
  ): BucketBuilder<D, P, C2, HasFiles, Entities>;
  /** Initialize shared state on cold start with lambda options. Receives bucket (self-client), deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles, Entities>) => C2 | Promise<C2>,
    lambda: LambdaOptions,
  ): BucketBuilder<D, P, C2, HasFiles, Entities>;

  /** Handle errors thrown by callbacks */
  onError(
    fn: (args: { error: unknown } & SpreadCtx<C>) => void | Promise<void>
  ): BucketBuilder<D, P, C, HasFiles, Entities>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): BucketBuilder<D, P, C, HasFiles, Entities>;

  /** Handle S3 ObjectCreated events (terminal — returns finalized handler) */
  onObjectCreated(
    fn: BucketObjectCreatedFn<C>
  ): BucketHandler<C, Entities>;

  /** Handle S3 ObjectRemoved events (terminal — returns finalized handler) */
  onObjectRemoved(
    fn: BucketObjectRemovedFn<C>
  ): BucketHandler<C, Entities>;

  /** Finalize as resource-only bucket (no Lambda) */
  build(): BucketHandler<C, Entities>;
}

// ============ Implementation ============

/**
 * Define an S3 bucket with optional event handlers.
 *
 * @see {@link https://effortless-aws.website/use-cases/storage | Storage guide}
 *
 * @example
 * ```typescript
 * export const uploads = defineBucket({ prefix: "images/", suffix: ".jpg" })
 *   .onObjectCreated(async ({ event, bucket }) => {
 *     console.log("New upload:", event.key);
 *   })
 * ```
 */
export function defineBucket(): BucketBuilder;
export function defineBucket(
  options: BucketOptions,
): BucketBuilder;
export function defineBucket(
  options?: BucketOptions,
): BucketBuilder {
  const bucketConfig = options ?? {} as BucketOptions;

  const spec: BucketConfig = {
    ...bucketConfig,
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
  };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
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
    include(glob: string) {
      state.static = [...(state.static ?? []), glob];
      return builder as any;
    },
    entity(name: string, options?: BucketEntityConfig) {
      state.spec = {
        ...state.spec,
        entities: { ...state.spec.entities, [name]: options ?? {} },
      };
      return builder as any;
    },
    setup(fnOrLambda: any, maybeLambda?: LambdaOptions) {
      if (typeof fnOrLambda === "function") {
        state.setup = fnOrLambda;
        if (maybeLambda) applyLambdaOptions(maybeLambda);
      } else {
        applyLambdaOptions(fnOrLambda);
      }
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
