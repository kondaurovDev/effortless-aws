import type { AnySecretRef, ResolveConfig, LambdaWithPermissions, ConfigFactory, LambdaOptions, Duration } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";

// ============ Static config ============

/** Fargate container size presets */
export type FargateSize =
  | "0.25vCPU-512mb"
  | "0.5vCPU-1gb"
  | "1vCPU-2gb"
  | "2vCPU-4gb"
  | "4vCPU-8gb";

/** Static config extracted at deploy time */
export type WorkerConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** Fargate size (default: "0.5vCPU-1gb") */
  size?: FargateSize;
  /** How long the worker stays alive without messages before shutting down (default: "5m") */
  idleTimeout?: Duration;
  /** Max messages processed in parallel (default: 1, max: 10) */
  concurrency?: number;
};

// ============ Setup args ============

/** Setup factory — receives deps/config/files based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

// ============ Handler callback ============

/** Callback function for the worker's onMessage */
export type WorkerMessageFn<T, C = undefined> =
  (msg: T, ctx: SpreadCtx<C>) => Promise<void> | void;

// ============ Handler type ============

/**
 * Handler object created by defineWorker.
 * @internal
 */
export type WorkerHandler<T = any, C = any> = {
  readonly __brand: "effortless-worker";
  readonly __spec: WorkerConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onMessage?: (...args: any[]) => any;
};

// ============ Options ============

/** Options passed to `defineWorker()` — resource config only */
type WorkerOptions = {
  /** Fargate size (default: "0.5vCPU-1gb") */
  size?: FargateSize;
  /** How long the worker stays alive without messages before shutting down (default: "5m") */
  idleTimeout?: Duration;
  /** Max messages processed in parallel (default: 1, max: 10) */
  concurrency?: number;
};

// ============ Builder ============

interface WorkerBuilder<
  T,
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers, workers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): WorkerBuilder<T, D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): WorkerBuilder<T, D, P2, C, HasFiles>;

  /** Include static files in the bundle. Chainable — call multiple times. */
  include(glob: string): WorkerBuilder<T, D, P, C, true>;

  /** Configure Lambda settings only (memory, timeout, permissions, logLevel) */
  setup(lambda: LambdaOptions): WorkerBuilder<T, D, P, C, HasFiles>;

  /** Initialize shared state on cold start. Receives deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>
  ): WorkerBuilder<T, D, P, C2, HasFiles>;

  /** Initialize shared state on cold start + configure Lambda settings. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>,
    lambda: LambdaOptions
  ): WorkerBuilder<T, D, P, C2, HasFiles>;

  /** Handle errors thrown by onMessage. Return "delete" to discard, "retry" to reprocess (default). */
  onError(
    fn: (args: { error: unknown; msg: T; retryCount: number } & SpreadCtx<C>) => "retry" | "delete" | void | Promise<"retry" | "delete" | void>
  ): WorkerBuilder<T, D, P, C, HasFiles>;

  /** Cleanup callback — runs when the worker shuts down */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): WorkerBuilder<T, D, P, C, HasFiles>;

  /** Process a single message from the queue (terminal) */
  onMessage(
    fn: WorkerMessageFn<T, C>
  ): WorkerHandler<T, C>;
}

// ============ Implementation ============

/**
 * Define a worker — a long-running Fargate container with an SQS queue.
 *
 * The worker stays alive while processing messages and shuts down after
 * an idle timeout with no new messages. Other handlers can send messages
 * to the worker via `deps.worker.send(msg)`.
 *
 * @typeParam T - Type of messages the worker receives via its queue
 *
 * @example
 * ```typescript
 * type Job = { type: "export"; userId: string }
 *
 * export const worker = defineWorker<Job>({ memory: 2048, concurrency: 5 })
 *   .deps(() => ({ orders }))
 *   .setup(async ({ deps }) => ({ db: deps.orders }))
 *   .onMessage(async (msg, { db }) => {
 *     await processJob(msg, db)
 *   })
 * ```
 */
export function defineWorker<T = unknown>(options?: WorkerOptions): WorkerBuilder<T> {
  const spec: WorkerConfig = {
    ...(options?.size ? { size: options.size } : {}),
    ...(options?.idleTimeout ? { idleTimeout: options.idleTimeout } : {}),
    ...(options?.concurrency ? { concurrency: options.concurrency } : {}),
  };

  const state: {
    spec: WorkerConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    onMessage?: (...args: any[]) => any;
  } = { spec };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): WorkerHandler => ({
    __brand: "effortless-worker",
    __spec: state.spec,
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.onMessage ? { onMessage: state.onMessage } : {}),
  }) as WorkerHandler;

  const builder: WorkerBuilder<T> = {
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
    onError(fn) {
      state.onError = fn as any;
      return builder as any;
    },
    onCleanup(fn) {
      state.onCleanup = fn as any;
      return builder as any;
    },
    onMessage(fn) {
      state.onMessage = fn as any;
      return finalize() as any;
    },
  };

  return builder;
}
