import type { LambdaWithPermissions, ResolveConfig, TableItem, Duration, ConfigFactory } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { TableClient } from "../runtime/table-client";
import type { ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";

/** DynamoDB attribute types for keys */
export type KeyType = "string" | "number" | "binary";

/**
 * DynamoDB table key definition
 */
export type TableKey = {
  /** Attribute name */
  name: string;
  /** Attribute type */
  type: KeyType;
};

/** DynamoDB Streams view type - determines what data is captured in stream records */
export type StreamView = "NEW_AND_OLD_IMAGES" | "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY";

/**
 * Configuration options for defineTable (single-table design).
 *
 * Tables always use `pk (S)` + `sk (S)` keys, `tag (S)` discriminator,
 * `data (M)` for domain fields, and `ttl (N)` for optional expiration.
 */
export type TableConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** DynamoDB billing mode (default: "PAY_PER_REQUEST") */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Stream view type - what data to include in stream records (default: "NEW_AND_OLD_IMAGES") */
  streamView?: StreamView;
  /** Number of records to process in each Lambda invocation (1-10000, default: 100) */
  batchSize?: number;
  /** Maximum time to gather records before invoking (default: `"2s"`). Accepts `"5s"`, `"1m"`, etc. */
  batchWindow?: Duration;
  /** Where to start reading the stream (default: "LATEST") */
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  /** Number of records to process concurrently within a batch (default: 1 — sequential) */
  concurrency?: number;
  /**
   * Name of the field in `data` that serves as the entity type discriminant.
   * Effortless auto-copies `data[tagField]` to the top-level DynamoDB `tag` attribute on `put()`.
   * Defaults to `"tag"`.
   */
  tagField?: string;
};

/**
 * DynamoDB stream record passed to onRecord callback.
 *
 * `new` and `old` are full `TableItem<T>` objects with the single-table envelope.
 *
 * @typeParam T - Type of the domain data (inside `data`)
 */
export type TableRecord<T = Record<string, unknown>> = {
  /** Type of modification: INSERT, MODIFY, or REMOVE */
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  /** New item value (present for INSERT and MODIFY) */
  new?: TableItem<T>;
  /** Old item value (present for MODIFY and REMOVE) */
  old?: TableItem<T>;
  /** Primary key of the affected item */
  keys: { pk: string; sk: string };
  /** Sequence number for ordering */
  sequenceNumber?: string;
  /** Approximate timestamp when the modification occurred */
  timestamp?: number;
};

/**
 * Setup factory type for table handlers.
 * Receives `table: TableClient<T>` (self-client for the handler's own table).
 * Also receives `deps` and/or `config` when declared.
 */
type SetupFactory<C, T, D, P, S extends string[] | undefined = undefined> = (args:
    & { table: TableClient<T> }
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => C | Promise<C>;

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

/**
 * Callback function type for processing a single DynamoDB stream record.
 * Receives the current record and the full batch for context.
 */
export type TableRecordFn<T = Record<string, unknown>, C = undefined> =
  (args: { record: TableRecord<T>; batch: readonly TableRecord<T>[] }
    & SpreadCtx<C>
  ) => Promise<void>;

/**
 * Batch handler function for DynamoDB stream records.
 * Called once with all records in the batch.
 * Return `{ failures: string[] }` (sequence numbers) for partial batch failure reporting.
 */
export type TableBatchFn<T = Record<string, unknown>, C = undefined> =
  (args: { records: readonly TableRecord<T>[] }
    & SpreadCtx<C>
  ) => Promise<void | { failures: string[] }>;

/** Base options shared by all defineTable variants */
type DefineTableBase<
  T = Record<string, unknown>,
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> = Omit<TableConfig, "tagField"> & {
  /** Name of the field in `data` that serves as the entity type discriminant (default: `"tag"`). */
  tagField?: Extract<keyof T, string>;
  /**
   * Decode/validate function for the `data` portion of stream record items.
   * Called with the unmarshalled `data` attribute; should return typed data or throw on validation failure.
   * When provided, T is inferred from the return type — no need to specify generic parameters.
   */
  schema?: (input: unknown) => T;
  /**
   * Error handler called when onRecord/onRecordBatch throws.
   * If not provided, defaults to `console.error`.
   */
  onError?: (args: { error: unknown } & SpreadCtx<C>) => void;
  /** Called after each invocation completes, right before Lambda freezes the process */
  onAfterInvoke?: (args: SpreadCtx<C>) => void | Promise<void>;
  /**
   * Factory function to initialize shared state for callbacks.
   * Called once on cold start, result is cached and reused across invocations.
   * Receives `table` (self-client), plus `deps`/`config`/`files` when declared.
   */
  setup?: SetupFactory<C, T, NoInfer<D>, NoInfer<P>, NoInfer<S>>;
  /**
   * Dependencies on other handlers (tables, queues, etc.).
   * Typed clients are injected into setup via the `deps` argument.
   * Pass a function returning the deps object: `deps: () => ({ orders })`.
   */
  deps?: () => D & {};
  /**
   * SSM Parameter Store parameters.
   * Declare with `defineSecret()` helper. Values are fetched and cached at cold start.
   */
  config?: ConfigFactory<P>;
  /**
   * Static file glob patterns to bundle into the Lambda ZIP.
   * Files are accessible at runtime via the `files` argument in setup.
   */
  static?: S;
};

/**
 * Options for defineTable.
 * `onRecord` and `onRecordBatch` are mutually exclusive. Both are optional (table-only mode).
 */
export type DefineTableOptions<
  T = Record<string, unknown>,
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> = DefineTableBase<T, C, D, P, S> & (
  | {
      /**
       * Per-record stream handler. Called once per record in the batch.
       * Runtime handles partial batch failure reporting automatically.
       * Records are processed with configurable `concurrency` (default: 1 — sequential).
       */
      onRecord?: TableRecordFn<T, C>;
      onRecordBatch?: never;
    }
  | {
      /**
       * Batch stream handler. Called once with all records in the batch.
       * Return `{ failures: string[] }` with sequence numbers for partial batch failure.
       */
      onRecordBatch?: TableBatchFn<T, C>;
      onRecord?: never;
    }
  | { onRecord?: never; onRecordBatch?: never }
);

/**
 * Internal handler object created by defineTable
 * @internal
 */
export type TableHandler<T = Record<string, unknown>, C = any> = {
  readonly __brand: "effortless-table";
  readonly __spec: TableConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (...args: any[]) => any;
  readonly onAfterInvoke?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onRecord?: (...args: any[]) => any;
  readonly onRecordBatch?: (...args: any[]) => any;
};

/**
 * Define a DynamoDB table with optional stream handler (single-table design).
 *
 * Creates a table with fixed key schema: `pk (S)` + `sk (S)`, plus `tag (S)`,
 * `data (M)`, and `ttl (N)` attributes. TTL is always enabled.
 *
 * @example Table with stream handler
 * ```typescript
 * export const orders = defineTable<OrderData>()({
 *   batchSize: 10,
 *   concurrency: 5,
 *   setup: ({ table }) => ({ table }),
 *   onRecord: async ({ record, batch, table }) => {
 *     if (record.eventName === "INSERT") {
 *       console.log("New order:", record.new?.data);
 *     }
 *   }
 * });
 * ```
 *
 * @example Table with runtime validation
 * ```typescript
 * export const orders = defineTable<OrderData>()({
 *   schema: (input) => OrderSchema.parse(input),
 *   onRecord: async ({ record }) => { ... }
 * });
 * ```
 *
 * @example Table only (no Lambda)
 * ```typescript
 * export const users = defineTable()({});
 * ```
 */
export const defineTable = <T = Record<string, unknown>>() => <
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineTableOptions<T, C, D, P, S>
): TableHandler<T, C> => {
  const { onRecord, onRecordBatch, onError, onAfterInvoke, schema, setup, deps, config: configFactory, static: staticFiles, ...__spec } = options;
  const config = configFactory ? resolveConfigFactory(configFactory) : undefined;
  return {
    __brand: "effortless-table",
    __spec,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(onAfterInvoke ? { onAfterInvoke } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
    ...(onRecord ? { onRecord } : {}),
    ...(onRecordBatch ? { onRecordBatch } : {}),
  } as TableHandler<T, C>;
};
