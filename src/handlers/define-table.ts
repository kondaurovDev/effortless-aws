import type { Permission } from "./permissions";
import type { TableClient } from "../runtime/table-client";
import type { AnyParamRef, ResolveParams } from "./param";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTableHandler = TableHandler<any, any, any, any, any>;

/** Maps a deps declaration to resolved runtime client types */
type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T, any, any, any, any> ? TableClient<T> : never;
};

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
 * Configuration options extracted from DefineTableOptions (without onRecord/context)
 */
export type TableConfig = {
  /** Table/handler name. Defaults to export name if not specified */
  name?: string;
  /** Partition key definition */
  pk: TableKey;
  /** Sort key definition (optional) */
  sk?: TableKey;
  /** DynamoDB billing mode (default: "PAY_PER_REQUEST") */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** TTL attribute name for automatic item expiration */
  ttlAttribute?: string;
  /** Stream view type - what data to include in stream records (default: "NEW_AND_OLD_IMAGES") */
  streamView?: StreamView;
  /** Number of records to process in each Lambda invocation (1-10000, default: 100) */
  batchSize?: number;
  /** Maximum time in seconds to gather records before invoking (0-300, default: 2) */
  batchWindow?: number;
  /** Where to start reading the stream (default: "LATEST") */
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout in seconds (default: 30) */
  timeout?: number;
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
};

/**
 * DynamoDB stream record passed to onRecord callback
 *
 * @typeParam T - Type of the table items (new/old values)
 */
export type TableRecord<T = Record<string, unknown>> = {
  /** Type of modification: INSERT, MODIFY, or REMOVE */
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  /** New item value (present for INSERT and MODIFY) */
  new?: T;
  /** Old item value (present for MODIFY and REMOVE) */
  old?: T;
  /** Primary key of the affected item */
  keys: Record<string, unknown>;
  /** Sequence number for ordering */
  sequenceNumber?: string;
  /** Approximate timestamp when the modification occurred */
  timestamp?: number;
};

/**
 * Information about a failed record during batch processing
 *
 * @typeParam T - Type of the table items
 */
export type FailedRecord<T = Record<string, unknown>> = {
  /** The record that failed to process */
  record: TableRecord<T>;
  /** The error that occurred */
  error: unknown;
};

/**
 * Context factory type — conditional on whether params are declared.
 * Without params: `() => C | Promise<C>`
 * With params: `(args: { params: ResolveParams<P> }) => C | Promise<C>`
 */
type ContextFactory<C, P> = [P] extends [undefined]
  ? () => C | Promise<C>
  : (args: { params: ResolveParams<P & {}> }) => C | Promise<C>;

/**
 * Callback function type for processing a single DynamoDB stream record
 */
export type TableRecordFn<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined> =
  (args: { record: TableRecord<T>; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { params: ResolveParams<P> })
  ) => Promise<R>;

/**
 * Callback function type for processing accumulated batch results
 */
export type TableBatchCompleteFn<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined> =
  (args: { results: R[]; failures: FailedRecord<T>[]; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { params: ResolveParams<P> })
  ) => Promise<void>;

/**
 * Callback function type for processing all records in a batch at once
 */
export type TableBatchFn<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined> =
  (args: { records: TableRecord<T>[]; table: TableClient<T> }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { params: ResolveParams<P> })
  ) => Promise<void>;

/** Base options shared by all defineTable variants */
type DefineTableBase<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined> = TableConfig & {
  /**
   * Decode/validate function for stream record items (new/old images).
   * Called with the unmarshalled DynamoDB item; should return typed data or throw on validation failure.
   * When provided, T is inferred from the return type — no need to specify generic parameters.
   */
  schema?: (input: unknown) => T;
  /**
   * Error handler called when onRecord, onBatch, or onBatchComplete throws.
   * Receives the error. If not provided, defaults to `console.error`.
   */
  onError?: (error: unknown) => void;
  /**
   * Factory function to create context/dependencies for callbacks.
   * Called once on cold start, result is cached and reused across invocations.
   * When params are declared, receives resolved params as argument.
   * Supports both sync and async return values.
   */
  context?: ContextFactory<C, P>;
  /**
   * Dependencies on other handlers (tables, queues, etc.).
   * Typed clients are injected into the handler via the `deps` argument.
   */
  deps?: D;
  /**
   * SSM Parameter Store parameters.
   * Declare with `param()` helper. Values are fetched and cached at cold start.
   * Typed values are injected into the handler via the `params` argument.
   */
  params?: P;
};

/** Per-record processing: onRecord with optional onBatchComplete */
type DefineTableWithOnRecord<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined> = DefineTableBase<T, C, D, P> & {
  onRecord: TableRecordFn<T, C, R, D, P>;
  onBatchComplete?: TableBatchCompleteFn<T, C, R, D, P>;
  onBatch?: never;
};

/** Batch processing: onBatch processes all records at once */
type DefineTableWithOnBatch<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined> = DefineTableBase<T, C, D, P> & {
  onBatch: TableBatchFn<T, C, D, P>;
  onRecord?: never;
  onBatchComplete?: never;
};

/** Resource-only: no handler, just creates the table */
type DefineTableResourceOnly<T = Record<string, unknown>, C = undefined, D = undefined, P = undefined> = DefineTableBase<T, C, D, P> & {
  onRecord?: never;
  onBatch?: never;
  onBatchComplete?: never;
};

export type DefineTableOptions<
  T = Record<string, unknown>,
  C = undefined,
  R = void,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined
> =
  | DefineTableWithOnRecord<T, C, R, D, P>
  | DefineTableWithOnBatch<T, C, D, P>
  | DefineTableResourceOnly<T, C, D, P>;

/**
 * Internal handler object created by defineTable
 * @internal
 */
export type TableHandler<T = Record<string, unknown>, C = undefined, R = void, D = undefined, P = undefined> = {
  readonly __brand: "effortless-table";
  readonly config: TableConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly context?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly params?: P;
  readonly onRecord?: TableRecordFn<T, C, R, D, P>;
  readonly onBatchComplete?: TableBatchCompleteFn<T, C, R, D, P>;
  readonly onBatch?: TableBatchFn<T, C, D, P>;
};

/**
 * Define a DynamoDB table with optional stream handler
 *
 * Creates:
 * - DynamoDB table with specified key schema
 * - (If onRecord or onBatch provided) DynamoDB Stream + Lambda + Event Source Mapping
 *
 * @example Table with stream handler (typed)
 * ```typescript
 * type Order = { id: string; amount: number; status: string };
 *
 * export const orders = defineTable<Order>({
 *   pk: { name: "id", type: "string" },
 *   streamView: "NEW_AND_OLD_IMAGES",
 *   batchSize: 10,
 *   onRecord: async ({ record }) => {
 *     if (record.eventName === "INSERT") {
 *       console.log("New order:", record.new?.amount);
 *     }
 *   }
 * });
 * ```
 *
 * @example Table only (no Lambda)
 * ```typescript
 * export const users = defineTable({
 *   pk: { name: "id", type: "string" },
 *   sk: { name: "email", type: "string" }
 * });
 * ```
 */
export const defineTable = <
  T = Record<string, unknown>,
  C = undefined,
  R = void,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined
>(
  options: DefineTableOptions<T, C, R, D, P>
): TableHandler<T, C, R, D, P> => {
  const { onRecord, onBatchComplete, onBatch, onError, schema, context, deps, params, ...config } = options;
  return {
    __brand: "effortless-table",
    config,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(context ? { context } : {}),
    ...(deps ? { deps } : {}),
    ...(params ? { params } : {}),
    ...(onRecord ? { onRecord } : {}),
    ...(onBatchComplete ? { onBatchComplete } : {}),
    ...(onBatch ? { onBatch } : {})
  } as TableHandler<T, C, R, D, P>;
};
