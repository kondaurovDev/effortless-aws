import type { AnySecretRef, ResolveConfig, Duration, ConfigFactory, LogLevel, Permission, LambdaOptions } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { TableClient } from "../runtime/table-client";
import type { TableItem } from "./handler-options";
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
  lambda?: { memory?: number; timeout?: Duration; logLevel?: LogLevel; permissions?: Permission[] };
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

// ============ Setup args ============

/** Setup factory — receives table/deps/config/files based on what was declared */
type SetupArgs<T, D, P, HasFiles extends boolean> =
  & { table: TableClient<T> }
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

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

// ============ Static config ============

/** Static config extracted by AST (no runtime callbacks) */
// TableConfig is already defined above and used as the extracted config type.

// ============ Handler type (base interface for runtime wrappers and annotations) ============

/**
 * Handler object created by defineTable.
 * Used by runtime wrappers and as type annotation for circular deps.
 * @internal
 */
export type TableHandler<T = Record<string, unknown>, C = any> = {
  readonly __brand: "effortless-table";
  readonly __spec: TableConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onRecord?: (...args: any[]) => any;
  readonly onRecordBatch?: (...args: any[]) => any;
};

// ============ Builder options ============

/** Options passed to `defineTable()` — resource config only, no Lambda settings */
type TableOptions<T> = {
  /** DynamoDB billing mode (default: "PAY_PER_REQUEST") */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Stream view type (default: "NEW_AND_OLD_IMAGES") */
  streamView?: StreamView;
  /** Number of records to process in each Lambda invocation (1-10000, default: 100) */
  batchSize?: number;
  /** Maximum time to gather records before invoking (default: "2s") */
  batchWindow?: Duration;
  /** Where to start reading the stream (default: "LATEST") */
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  /** Number of records to process concurrently within a batch (default: 1) */
  concurrency?: number;
  /** Name of the field in `data` that serves as the entity type discriminant (default: "tag") */
  tagField?: Extract<keyof T, string>;
  /** Decode/validate function for the `data` portion of stream records */
  schema?: (input: unknown) => T;
};

// ============ Builder ============

interface TableBuilder<
  T = Record<string, unknown>,
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): TableBuilder<T, D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): TableBuilder<T, D, P2, C, HasFiles>;

  /** Include static files in the Lambda bundle. Chainable — call multiple times. */
  include(glob: string): TableBuilder<T, D, P, C, true>;

  /** Configure Lambda settings only (memory, timeout, permissions, etc.) */
  setup(
    lambda: LambdaOptions
  ): TableBuilder<T, D, P, C, HasFiles>;

  /** Initialize shared state on cold start. Receives table (self-client), deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<T, D, P, HasFiles>) => C2 | Promise<C2>
  ): TableBuilder<T, D, P, C2, HasFiles>;

  /** Initialize shared state on cold start + configure Lambda settings. */
  setup<C2>(
    fn: (args: SetupArgs<T, D, P, HasFiles>) => C2 | Promise<C2>,
    lambda: LambdaOptions
  ): TableBuilder<T, D, P, C2, HasFiles>;

  /** Handle errors thrown by onRecord/onRecordBatch */
  onError(
    fn: (args: { error: unknown } & SpreadCtx<C>) => void | Promise<void>
  ): TableBuilder<T, D, P, C, HasFiles>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): TableBuilder<T, D, P, C, HasFiles>;

  /** Per-record stream handler (terminal — returns finalized handler) */
  onRecord(
    fn: TableRecordFn<T, C>
  ): TableHandler<T, C>;

  /** Batch stream handler (terminal — returns finalized handler) */
  onRecordBatch(
    fn: TableBatchFn<T, C>
  ): TableHandler<T, C>;

  /** Finalize as resource-only table (no Lambda) */
  build(): TableHandler<T, C>;
}

// ============ Implementation ============

/**
 * Define a DynamoDB table with optional stream handler (single-table design).
 *
 * Creates a table with fixed key schema: `pk (S)` + `sk (S)`, plus `tag (S)`,
 * `data (M)`, and `ttl (N)` attributes. TTL is always enabled.
 *
 * @see {@link https://effortless-aws.website/use-cases/database | Database guide}
 *
 * @example
 * ```typescript
 * export const orders = defineTable<OrderData>({ batchSize: 10, concurrency: 5 })
 *   .setup(({ table }) => ({ table }))
 *   .onRecord(async ({ record, table }) => {
 *     if (record.eventName === "INSERT") {
 *       console.log("New order:", record.new?.data);
 *     }
 *   })
 * ```
 */
export function defineTable<T = Record<string, unknown>>(): TableBuilder<T>;
export function defineTable<T = Record<string, unknown>>(
  options: TableOptions<T>,
): TableBuilder<T>;
export function defineTable<T = Record<string, unknown>>(
  options?: TableOptions<T>,
): TableBuilder<T> {
  const {
    schema,
    ...tableConfig
  } = options ?? {} as TableOptions<T>;

  const spec: TableConfig = { ...tableConfig };

  const state: {
    spec: TableConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    schema?: (input: unknown) => T;
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    onRecord?: (...args: any[]) => any;
    onRecordBatch?: (...args: any[]) => any;
  } = {
    spec,
    ...(schema ? { schema } : {}),
  };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): TableHandler<T> => ({
    __brand: "effortless-table",
    __spec: state.spec,
    ...(state.schema ? { schema: state.schema } : {}),
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.onRecord ? { onRecord: state.onRecord } : {}),
    ...(state.onRecordBatch ? { onRecordBatch: state.onRecordBatch } : {}),
  }) as TableHandler<T>;

  const builder: TableBuilder<T> = {
    deps(fn) {
      state.deps = fn as any;
      return builder as any;
    },
    config(fn) {
      state.config = resolveConfigFactory(fn) as any;
      return builder as any;
    },
    include(glob) {
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
    onRecord(fn) {
      state.onRecord = fn as any;
      return finalize() as any;
    },
    onRecordBatch(fn) {
      state.onRecordBatch = fn as any;
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
