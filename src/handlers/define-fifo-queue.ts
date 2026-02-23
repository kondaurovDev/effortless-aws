import type { LambdaWithPermissions, AnyParamRef, ResolveConfig } from "../helpers";
import type { AnyDepHandler, ResolveDeps, StaticFiles } from "./shared";

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
export type FifoQueueConfig = LambdaWithPermissions & {
  /** Number of messages per Lambda invocation (1-10 for FIFO, default: 10) */
  batchSize?: number;
  /** Maximum time in seconds to gather messages before invoking (0-300, default: 0) */
  batchWindow?: number;
  /** Visibility timeout in seconds (default: max of timeout or 30) */
  visibilityTimeout?: number;
  /** Message retention period in seconds (60-1209600, default: 345600 = 4 days) */
  retentionPeriod?: number;
  /** Enable content-based deduplication (default: true) */
  contentBasedDeduplication?: boolean;
};

/**
 * Setup factory type — always receives an args object.
 * Args include `deps` and/or `config` when declared (empty `{}` otherwise).
 */
type SetupFactory<C, D, P, S extends string[] | undefined = undefined> =
  (args:
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => C | Promise<C>;

/**
 * Per-message handler function.
 * Called once per message in the batch. Failures are reported individually.
 */
export type FifoQueueMessageFn<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { message: FifoQueueMessage<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<void>;

/**
 * Batch handler function.
 * Called once with all messages in the batch.
 */
export type FifoQueueBatchFn<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { messages: FifoQueueMessage<T>[] }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<void>;

/** Base options shared by all defineFifoQueue variants */
type DefineFifoQueueBase<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = FifoQueueConfig & {
  /**
   * Decode/validate function for the message body.
   * Called with the JSON-parsed body; should return typed data or throw on validation failure.
   */
  schema?: (input: unknown) => T;
  /**
   * Error handler called when onMessage or onBatch throws.
   * If not provided, defaults to `console.error`.
   */
  onError?: (error: unknown) => void;
  /**
   * Factory function to initialize shared state for the handler.
   * Called once on cold start, result is cached and reused across invocations.
   * When deps/params are declared, receives them as argument.
   */
  setup?: SetupFactory<C, D, P, S>;
  /**
   * Dependencies on other handlers (tables, queues, etc.).
   * Typed clients are injected into the handler via the `deps` argument.
   */
  deps?: D;
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

/** Per-message processing */
type DefineFifoQueueWithOnMessage<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineFifoQueueBase<T, C, D, P, S> & {
  onMessage: FifoQueueMessageFn<T, C, D, P, S>;
  onBatch?: never;
};

/** Batch processing: all messages at once */
type DefineFifoQueueWithOnBatch<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineFifoQueueBase<T, C, D, P, S> & {
  onBatch: FifoQueueBatchFn<T, C, D, P, S>;
  onMessage?: never;
};

export type DefineFifoQueueOptions<
  T = unknown,
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
> =
  | DefineFifoQueueWithOnMessage<T, C, D, P, S>
  | DefineFifoQueueWithOnBatch<T, C, D, P, S>;

/**
 * Internal handler object created by defineFifoQueue
 * @internal
 */
export type FifoQueueHandler<T = unknown, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = {
  readonly __brand: "effortless-fifo-queue";
  readonly __spec: FifoQueueConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly config?: P;
  readonly static?: string[];
  readonly onMessage?: FifoQueueMessageFn<T, C, D, P, S>;
  readonly onBatch?: FifoQueueBatchFn<T, C, D, P, S>;
};

/**
 * Define a FIFO SQS queue with a Lambda message handler
 *
 * Creates:
 * - SQS FIFO queue (with `.fifo` suffix)
 * - Lambda function triggered by the queue
 * - Event source mapping with partial batch failure support
 *
 * @example Per-message processing
 * ```typescript
 * type OrderEvent = { orderId: string; action: string };
 *
 * export const orderQueue = defineFifoQueue<OrderEvent>({
 *   onMessage: async ({ message }) => {
 *     console.log("Processing order:", message.body.orderId);
 *   }
 * });
 * ```
 *
 * @example Batch processing with schema
 * ```typescript
 * export const notifications = defineFifoQueue({
 *   schema: (input) => NotificationSchema.parse(input),
 *   batchSize: 5,
 *   onBatch: async ({ messages }) => {
 *     await sendAll(messages.map(m => m.body));
 *   }
 * });
 * ```
 */
export const defineFifoQueue = <
  T = unknown,
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineFifoQueueOptions<T, C, D, P, S>
): FifoQueueHandler<T, C, D, P, S> => {
  const { onMessage, onBatch, onError, schema, setup, deps, config, static: staticFiles, ...__spec } = options;
  return {
    __brand: "effortless-fifo-queue",
    __spec,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
    ...(onMessage ? { onMessage } : {}),
    ...(onBatch ? { onBatch } : {})
  } as FifoQueueHandler<T, C, D, P, S>;
};
