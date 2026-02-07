import type { Permission } from "./permissions";

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
 * Callback function type for processing a single DynamoDB stream record
 *
 * @typeParam T - Type of the table items
 * @typeParam C - Type of the context/dependencies (from context function)
 * @typeParam R - Return type (can be void or a value to accumulate)
 */
export type TableRecordFn<T = Record<string, unknown>, C = undefined, R = void> =
  C extends undefined
    ? (args: { record: TableRecord<T> }) => Promise<R>
    : (args: { record: TableRecord<T>; ctx: C }) => Promise<R>;

/**
 * Callback function type for processing accumulated batch results
 *
 * @typeParam T - Type of the table items
 * @typeParam C - Type of the context/dependencies
 * @typeParam R - Type of results accumulated from onRecord
 */
export type TableBatchCompleteFn<T = Record<string, unknown>, C = undefined, R = void> =
  C extends undefined
    ? (args: { results: R[]; failures: FailedRecord<T>[] }) => Promise<void>
    : (args: { results: R[]; failures: FailedRecord<T>[]; ctx: C }) => Promise<void>;

/**
 * Options for defining a DynamoDB table with optional stream handler
 *
 * @typeParam T - Type of the table items for type-safe record access
 * @typeParam C - Type of the context/dependencies returned by context function
 *
 * @example Without context
 * ```typescript
 * export const users = defineTable<User>({
 *   pk: { name: "id", type: "string" },
 *   onRecord: async ({ record }) => {
 *     console.log(record.new?.name);
 *   }
 * });
 * ```
 *
 * @example With context (e.g., Effect runtime)
 * ```typescript
 * export const orders = defineTable<Order, ManagedRuntime<...>>({
 *   pk: { name: "id", type: "string" },
 *   context: () => ManagedRuntime.make(
 *     Layer.mergeAll(ConfigLive, DbClientLive)
 *   ),
 *   onRecord: async ({ record, ctx }) => {
 *     await ctx.runPromise(processOrder(record));
 *   }
 * });
 * ```
 */
export type DefineTableOptions<T = Record<string, unknown>, C = undefined, R = void> = TableConfig & {
  /**
   * Factory function to create context/dependencies for onRecord callback.
   * Called once on cold start, result is cached and reused across invocations.
   */
  context?: () => C;
  /** Stream record callback. If omitted, only the table is created (no Lambda) */
  onRecord?: TableRecordFn<T, C, R>;
  /**
   * Callback invoked after all records in the batch are processed.
   * Receives accumulated results from onRecord and list of failures.
   */
  onBatchComplete?: TableBatchCompleteFn<T, C, R>;
};

/**
 * Internal handler object created by defineTable
 * @internal
 */
export type TableHandler<T = Record<string, unknown>, C = undefined, R = void> = {
  readonly __brand: "effortless-table";
  readonly config: TableConfig;
  readonly context?: () => C;
  readonly onRecord?: TableRecordFn<T, C, R>;
  readonly onBatchComplete?: TableBatchCompleteFn<T, C, R>;
};

/**
 * Define a DynamoDB table with optional stream handler
 *
 * Creates:
 * - DynamoDB table with specified key schema
 * - (If onRecord provided) DynamoDB Stream + Lambda + Event Source Mapping
 *
 * @typeParam T - Type of the table items for type-safe record access
 * @typeParam C - Type of the context/dependencies (inferred from context function)
 * @param options - Table configuration, optional context factory, and optional onRecord callback
 * @returns Handler object used by the deployment system
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
 * @example With Effect runtime context
 * ```typescript
 * export const expenses = defineTable<Expense, typeof expenseRuntime>({
 *   pk: { name: "pk", type: "string" },
 *   context: () => ManagedRuntime.make(
 *     Layer.mergeAll(ConfigLive, DynamoDBClient.Default())
 *   ),
 *   onRecord: async ({ record, ctx }) => {
 *     await ctx.runPromise(processExpense(record));
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
export const defineTable = <T = Record<string, unknown>, C = undefined, R = void>(
  options: DefineTableOptions<T, C, R>
): TableHandler<T, C, R> => {
  const { onRecord, onBatchComplete, context, ...config } = options;
  return {
    __brand: "effortless-table",
    config,
    ...(context ? { context } : {}),
    ...(onRecord ? { onRecord } : {}),
    ...(onBatchComplete ? { onBatchComplete } : {})
  } as TableHandler<T, C, R>;
};
