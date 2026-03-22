import type { AnySecretRef, ResolveConfig, Duration, ConfigFactory, LogLevel, Permission, LambdaOptions } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";

/**
 * Parsed SQS FIFO message passed to the handler callbacks.
 *
 * @typeParam T - Type of the decoded message body (from schema function)
 */
export type FifoQueueMessage<T = unknown> = {
  /** Unique message identifier */
  messageId: string;
  /** Receipt handle for acknowledgement */
  receiptHandle: string;
  /** Parsed message body (JSON-decoded, then optionally schema-validated) */
  body: T;
  /** Raw unparsed message body string */
  rawBody: string;
  /** Message group ID (FIFO ordering key) */
  messageGroupId: string;
  /** Message deduplication ID */
  messageDeduplicationId?: string;
  /** SQS message attributes */
  messageAttributes: Record<string, { dataType?: string; stringValue?: string }>;
  /** Approximate first receive timestamp */
  approximateFirstReceiveTimestamp?: string;
  /** Approximate receive count */
  approximateReceiveCount?: string;
  /** Sent timestamp */
  sentTimestamp?: string;
};

/**
 * Configuration options for a FIFO queue handler
 */
export type FifoQueueConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: { memory?: number; timeout?: Duration; logLevel?: LogLevel; permissions?: Permission[] };
  /** Number of messages per Lambda invocation (1-10 for FIFO, default: 10) */
  batchSize?: number;
  /** Maximum time to gather messages before invoking (default: 0). Accepts `"5s"`, `"1m"`, etc. */
  batchWindow?: Duration;
  /** Visibility timeout (default: max of timeout or 30s). Accepts `"30s"`, `"5m"`, etc. */
  visibilityTimeout?: Duration;
  /** Message retention period (default: `"4d"`). Accepts `"1h"`, `"7d"`, etc. */
  retentionPeriod?: Duration;
  /** Delivery delay for all messages in the queue (default: 0). Accepts `"30s"`, `"5m"`, etc. */
  delay?: Duration;
  /** Enable content-based deduplication (default: true) */
  contentBasedDeduplication?: boolean;
  /** Max number of receives before a message is sent to the dead-letter queue (default: 3) */
  maxReceiveCount?: number;
};

// ============ Setup args ============

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

/** Setup factory — receives deps/config/files based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/**
 * Per-message handler function.
 * Called once per message in the batch. Failures are reported individually.
 */
export type FifoQueueMessageFn<T = unknown, C = undefined> =
  (args: { message: FifoQueueMessage<T> }
    & SpreadCtx<C>
  ) => Promise<void>;

/**
 * Batch handler function.
 * Called once with all messages in the batch.
 * Return `{ failures: string[] }` (messageIds) for partial batch failure reporting.
 */
export type FifoQueueBatchFn<T = unknown, C = undefined> =
  (args: { messages: FifoQueueMessage<T>[] }
    & SpreadCtx<C>
  ) => Promise<void | { failures: string[] }>;

// ============ Internal handler object ============

/**
 * Internal handler object created by defineFifoQueue
 * @internal
 */
export type FifoQueueHandler<T = unknown, C = any> = {
  readonly __brand: "effortless-fifo-queue";
  readonly __spec: FifoQueueConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onMessage?: (...args: any[]) => any;
  readonly onMessageBatch?: (...args: any[]) => any;
};

// ============ Builder options ============

/** Options passed to `defineFifoQueue()` — static config */
type FifoQueueOptions<T> = {
  /** Number of messages per Lambda invocation (1-10 for FIFO, default: 10) */
  batchSize?: number;
  /** Maximum time to gather messages before invoking (default: 0) */
  batchWindow?: Duration;
  /** Visibility timeout (default: max of timeout or 30s) */
  visibilityTimeout?: Duration;
  /** Message retention period (default: "4d") */
  retentionPeriod?: Duration;
  /** Delivery delay for all messages in the queue (default: 0) */
  delay?: Duration;
  /** Enable content-based deduplication (default: true) */
  contentBasedDeduplication?: boolean;
  /** Max number of receives before DLQ (default: 3) */
  maxReceiveCount?: number;
  /** Decode/validate function for the message body */
  schema?: (input: unknown) => T;
};

// ============ Builder ============

interface FifoQueueBuilder<
  T = unknown,
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): FifoQueueBuilder<T, D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): FifoQueueBuilder<T, D, P2, C, HasFiles>;

  /** Include static files in the Lambda bundle. Chainable — call multiple times. */
  include(glob: string): FifoQueueBuilder<T, D, P, C, true>;

  /** Configure Lambda settings only (memory, timeout, permissions, etc.) */
  setup(
    lambda: LambdaOptions
  ): FifoQueueBuilder<T, D, P, C, HasFiles>;

  /** Initialize shared state on cold start. Receives deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>
  ): FifoQueueBuilder<T, D, P, C2, HasFiles>;

  /** Initialize shared state on cold start + configure Lambda settings. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>,
    lambda: LambdaOptions
  ): FifoQueueBuilder<T, D, P, C2, HasFiles>;

  /** Handle errors thrown by message handlers */
  onError(
    fn: (args: { error: unknown } & SpreadCtx<C>) => void
  ): FifoQueueBuilder<T, D, P, C, HasFiles>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): FifoQueueBuilder<T, D, P, C, HasFiles>;

  /** Per-message handler (terminal — returns finalized handler) */
  onMessage(
    fn: FifoQueueMessageFn<T, C>
  ): FifoQueueHandler<T, C>;

  /** Batch handler (terminal — returns finalized handler) */
  onMessageBatch(
    fn: FifoQueueBatchFn<T, C>
  ): FifoQueueHandler<T, C>;
}

// ============ Implementation ============

/**
 * Define a FIFO SQS queue with a Lambda message handler.
 *
 * @see {@link https://effortless-aws.website/use-cases/queue | Queue guide}
 *
 * @example
 * ```typescript
 * export const notifications = defineFifoQueue({ batchSize: 5, schema: (i) => NotifSchema.parse(i) })
 *   .onMessageBatch(async ({ messages }) => {
 *     await sendAll(messages.map(m => m.body));
 *   })
 * ```
 */
export function defineFifoQueue<T = unknown>(): FifoQueueBuilder<T>;
export function defineFifoQueue<T = unknown>(
  options: FifoQueueOptions<T>,
): FifoQueueBuilder<T>;
export function defineFifoQueue<T = unknown>(
  options?: FifoQueueOptions<T>,
): FifoQueueBuilder<T> {
  const {
    schema,
    ...queueConfig
  } = options ?? {} as FifoQueueOptions<T>;

  const spec: FifoQueueConfig = { ...queueConfig };

  const state: {
    spec: FifoQueueConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    schema?: (input: unknown) => T;
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    onMessage?: (...args: any[]) => any;
    onMessageBatch?: (...args: any[]) => any;
  } = {
    spec,
    ...(schema ? { schema } : {}),
  };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): FifoQueueHandler<T> => ({
    __brand: "effortless-fifo-queue",
    __spec: state.spec,
    ...(state.schema ? { schema: state.schema } : {}),
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.onMessage ? { onMessage: state.onMessage } : {}),
    ...(state.onMessageBatch ? { onMessageBatch: state.onMessageBatch } : {}),
  }) as FifoQueueHandler<T>;

  const builder: FifoQueueBuilder<T> = {
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
    setup(fnOrLambda: any, maybeLambda?: LambdaOptions) {
      if (typeof fnOrLambda === "function") {
        state.setup = fnOrLambda;
        if (maybeLambda) applyLambdaOptions(maybeLambda);
      } else {
        applyLambdaOptions(fnOrLambda);
      }
      return builder as any;
    },
    onMessage(fn) {
      state.onMessage = fn as any;
      return finalize() as any;
    },
    onMessageBatch(fn) {
      state.onMessageBatch = fn as any;
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
  };

  return builder;
}
