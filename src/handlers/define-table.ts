import type { LambdaWithPermissions, AnyParamRef, ResolveConfig, TableItem } from "./handler-options";
import type { TableClient } from "../runtime/table-client";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
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
export type TableConfig = LambdaWithPermissions & {
  /** DynamoDB billing mode (default: "PAY_PER_REQUEST") */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Stream view type - what data to include in stream records (default: "NEW_AND_OLD_IMAGES") */
  streamView?: StreamView;
  /** Number of records to process in each Lambda invocation (1-10000, default: 100) */
  batchSize?: number;
  /** Maximum time in seconds to gather records before invoking (0-300, default: 2) */
  batchWindow?: number;
  /** Where to start reading the stream (default: "LATEST") */
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  /**
   * Name of the field in `data` that serves as the entity type discriminant.
   * Effortless auto-copies `data[tagField]` to the top-level DynamoDB `tag` attribute on `put()`.
   * Defaults to `"tag"`.
   *
   * @example
   * ```typescript
   * export const orders = defineTable({
   *   tagField: "type",
   *   schema: typed<{ type: "order"; amount: number }>(),
   *   onRecord: async ({ record }) => { ... }
   * });
   * ```
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
  keys: TableKey;
  /** Sequence number for ordering */
  sequenceNumber?: string;
  /** Approximate timestamp when the modification occurred */
  timestamp?: number;
};

/**
 * Information about a failed record during batch processing
 *
 * @typeParam T - Type of the domain data
 */
export type FailedRecord<T = Record<string, unknown>> = {
  /** The record that failed to process */
  record: TableRecord<T>;
  /** The error that occurred */
  error: unknown;
};

/**
 * Setup factory type for table handlers.
 * Always receives `table: TableClient<T>` (self-client for the handler's own table).
 * Also receives `deps` and/or `config` when declared.
 */
type SetupFactory<C, T, D, P, S extends string[] | undefined = undefined> = (args:
    & { table: TableClient<T> }
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => C | Promise<C>;

/**
 * Callback function type for processing a single DynamoDB stream record
 */
export type TableRecordFn<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { record: TableRecord<T>; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<R>;

/**
 * Callback function type for processing accumulated batch results
 */
export type TableBatchCompleteFn<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { results: R[]; failures: FailedRecord<T>[]; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<void>;

/**
 * Callback function type for processing all records in a batch at once
 */
export type TableBatchFn<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { records: TableRecord<T>[]; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<void>;

/** Base options shared by all defineTable variants */
type DefineTableBase<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = Omit<TableConfig, "tagField"> & {
  /** Name of the field in `data` that serves as the entity type discriminant (default: `"tag"`). */
  tagField?: Extract<keyof T, string>;
  /**
   * Decode/validate function for the `data` portion of stream record items.
   * Called with the unmarshalled `data` attribute; should return typed data or throw on validation failure.
   * When provided, T is inferred from the return type — no need to specify generic parameters.
   */
  schema?: (input: unknown) => T;
  /**
   * Error handler called when onRecord, onBatch, or onBatchComplete throws.
   * Receives the error. If not provided, defaults to `console.error`.
   */
  onError?: (error: unknown) => void;
  /**
   * Factory function to initialize shared state for callbacks.
   * Called once on cold start, result is cached and reused across invocations.
   * When deps/params are declared, receives them as argument.
   * Supports both sync and async return values.
   */
  setup?: SetupFactory<C, T, D, P, S>;
  /**
   * Dependencies on other handlers (tables, queues, etc.).
   * Typed clients are injected into the handler via the `deps` argument.
   */
  deps?: D;
  /**
   * SSM Parameter Store parameters.
   * Declare with `param()` helper. Values are fetched and cached at cold start.
   * Typed values are injected into the handler via the `config` argument.
   */
  config?: P;
  /**
   * Static file glob patterns to bundle into the Lambda ZIP.
   * Files are accessible at runtime via the `files` callback argument.
   */
  static?: S;
};

/** Per-record processing: onRecord with optional onBatchComplete */
type DefineTableWithOnRecord<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineTableBase<T, C, D, P, S> & {
  onRecord: TableRecordFn<T, C, R, D, P, S>;
  onBatchComplete?: TableBatchCompleteFn<T, C, R, D, P, S>;
  onBatch?: never;
};

/** Batch processing: onBatch processes all records at once */
type DefineTableWithOnBatch<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineTableBase<T, C, D, P, S> & {
  onBatch: TableBatchFn<T, C, D, P, S>;
  onRecord?: never;
  onBatchComplete?: never;
};

/** Resource-only: no handler, just creates the table */
type DefineTableResourceOnly<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = DefineTableBase<T, C, D, P, S> & {
  onRecord?: never;
  onBatch?: never;
  onBatchComplete?: never;
};

export type DefineTableOptions<
  T = Record<string, unknown>,
  C = undefined,
  R = void,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
> =
  | DefineTableWithOnRecord<T, C, R, D, P, S>
  | DefineTableWithOnBatch<T, C, D, P, S>
  | DefineTableResourceOnly<T, C, D, P, S>;

/**
 * Internal handler object created by defineTable
 * @internal
 */
export type TableHandler<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined, S extends string[] | undefined = undefined> = {
  readonly __brand: "effortless-table";
  readonly __spec: TableConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly config?: P;
  readonly static?: string[];
  readonly onRecord?: TableRecordFn<T, C, R, D, P, S>;
  readonly onBatchComplete?: TableBatchCompleteFn<T, C, R, D, P, S>;
  readonly onBatch?: TableBatchFn<T, C, D, P, S>;
};

/**
 * Define a DynamoDB table with optional stream handler (single-table design).
 *
 * Creates a table with fixed key schema: `pk (S)` + `sk (S)`, plus `tag (S)`,
 * `data (M)`, and `ttl (N)` attributes. TTL is always enabled.
 *
 * @example Table with stream handler (typed)
 * ```typescript
 * type OrderData = { amount: number; status: string };
 *
 * export const orders = defineTable({
 *   schema: typed<OrderData>(),
 *   streamView: "NEW_AND_OLD_IMAGES",
 *   batchSize: 10,
 *   onRecord: async ({ record }) => {
 *     if (record.eventName === "INSERT") {
 *       console.log("New order:", record.new?.data.amount);
 *     }
 *   }
 * });
 * ```
 *
 * @example Table only (no Lambda)
 * ```typescript
 * export const users = defineTable({});
 * ```
 */
export const defineTable = <
  T = Record<string, unknown>,
  C = undefined,
  R = void,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineTableOptions<T, C, R, D, P, S>
): TableHandler<T, C, R, D, P, S> => {
  const { onRecord, onBatchComplete, onBatch, onError, schema, setup, deps, config, static: staticFiles, ...__spec } = options;
  return {
    __brand: "effortless-table",
    __spec,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
    ...(onRecord ? { onRecord } : {}),
    ...(onBatchComplete ? { onBatchComplete } : {}),
    ...(onBatch ? { onBatch } : {})
  } as TableHandler<T, C, R, D, P, S>;
};
