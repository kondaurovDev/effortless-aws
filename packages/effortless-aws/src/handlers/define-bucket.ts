import type { LambdaWithPermissions, AnyParamRef, ResolveConfig } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";
import type { BucketClient } from "../runtime/bucket-client";
import type { HandlerArgs } from "./handler-args";

/**
 * Configuration options for defineBucket.
 */
export type BucketConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
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

/**
 * Callback function type for S3 ObjectCreated events
 */
export type BucketObjectCreatedFn<C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { event: BucketEvent; bucket: BucketClient }
    & HandlerArgs<C, D, P, S>
  ) => Promise<void>;

/**
 * Callback function type for S3 ObjectRemoved events
 */
export type BucketObjectRemovedFn<C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { event: BucketEvent; bucket: BucketClient }
    & HandlerArgs<C, D, P, S>
  ) => Promise<void>;

/**
 * Setup factory type for bucket handlers.
 * Always receives `bucket: BucketClient` (self-client for the handler's own bucket).
 * Also receives `deps` and/or `config` when declared.
 */
type SetupFactory<C, D, P, S extends string[] | undefined = undefined> = (args:
    & { bucket: BucketClient }
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => C | Promise<C>;

/** Base options shared by all defineBucket variants */
type DefineBucketBase<C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = BucketConfig & {
  /**
   * Error handler called when onObjectCreated or onObjectRemoved throws.
   * If not provided, defaults to `console.error`.
   */
  onError?: (args: { error: unknown } & HandlerArgs<C, D, P, S>) => void;
  /** Called after each invocation completes, right before Lambda freezes the process */
  onAfterInvoke?: (args: HandlerArgs<C, D, P, S>) => void | Promise<void>;
  /**
   * Factory function to initialize shared state for callbacks.
   * Called once on cold start, result is cached and reused across invocations.
   * Always receives `bucket: BucketClient` (self-client). When deps/config
   * are declared, receives them as well.
   */
  setup?: SetupFactory<C, D, P, S>;
  /**
   * Dependencies on other handlers (tables, buckets, etc.).
   * Typed clients are injected into the handler via the `deps` argument.
   * Pass a function returning the deps object: `deps: () => ({ uploads })`.
   */
  deps?: () => D & {};
  /**
   * SSM Parameter Store parameters.
   * Declare with `param()` helper. Values are fetched and cached at cold start.
   */
  config?: P;
  /**
   * Static file glob patterns to bundle into the Lambda ZIP.
   * Files are accessible at runtime via the `files` callback argument.
   */
  static?: S;
};

/** With event handlers (at least one callback) */
type DefineBucketWithHandlers<C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineBucketBase<C, D, P, S> & {
  onObjectCreated?: BucketObjectCreatedFn<C, D, P, S>;
  onObjectRemoved?: BucketObjectRemovedFn<C, D, P, S>;
};

/** Resource-only: no Lambda, just creates the bucket */
type DefineBucketResourceOnly<C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineBucketBase<C, D, P, S> & {
  onObjectCreated?: never;
  onObjectRemoved?: never;
};

export type DefineBucketOptions<
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
> =
  | DefineBucketWithHandlers<C, D, P, S>
  | DefineBucketResourceOnly<C, D, P, S>;

/**
 * Internal handler object created by defineBucket
 * @internal
 */
export type BucketHandler<C = any> = {
  readonly __brand: "effortless-bucket";
  readonly __spec: BucketConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onAfterInvoke?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onObjectCreated?: (...args: any[]) => any;
  readonly onObjectRemoved?: (...args: any[]) => any;
};

/**
 * Define an S3 bucket with optional event handlers.
 *
 * Creates an S3 bucket. When event handlers are provided, also creates a Lambda
 * function triggered by S3 event notifications.
 *
 * @example Bucket with event handler
 * ```typescript
 * export const uploads = defineBucket({
 *   prefix: "images/",
 *   suffix: ".jpg",
 *   onObjectCreated: async ({ event, bucket }) => {
 *     const file = await bucket.get(event.key);
 *     console.log("New upload:", event.key, file?.body.length);
 *   }
 * });
 * ```
 *
 * @example Resource-only bucket (no Lambda)
 * ```typescript
 * export const assets = defineBucket({});
 * ```
 *
 * @example As a dependency
 * ```typescript
 * export const api = defineApi({
 *   basePath: "/process",
 *   deps: { uploads },
 *   post: async ({ req, deps }) => {
 *     await deps.uploads.put("output.jpg", buffer);
 *     return { status: 200, body: "OK" };
 *   },
 * });
 * ```
 */
export const defineBucket = <
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineBucketOptions<C, D, P, S>
): BucketHandler<C> => {
  const { onObjectCreated, onObjectRemoved, onError, onAfterInvoke, setup, deps, config, static: staticFiles, ...__spec } = options;
  return {
    __brand: "effortless-bucket",
    __spec,
    ...(onError ? { onError } : {}),
    ...(onAfterInvoke ? { onAfterInvoke } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
    ...(onObjectCreated ? { onObjectCreated } : {}),
    ...(onObjectRemoved ? { onObjectRemoved } : {}),
  } as BucketHandler<C>;
};
