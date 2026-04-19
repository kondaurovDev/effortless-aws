import type { AnySecretRef, ResolveConfig, LambdaWithPermissions, ConfigFactory, LambdaOptions } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";
import type { Timezone } from "./timezone";

// ============ Schedule expression ============

/** Singular/plural unit for rate expressions */
type RateUnit = "minute" | "minutes" | "hour" | "hours" | "day" | "days";

/**
 * Rate expression: `rate(1 hour)`, `rate(5 minutes)`, `rate(2 days)`
 *
 * Strictly typed — autocomplete and compile-time validation for unit.
 */
type RateExpression = `rate(${number} ${RateUnit})`;

/**
 * Cron expression: `cron(min hour dom month dow year)`
 *
 * Not deeply typed (too combinatorial for TS), but the `cron(...)` wrapper is enforced.
 *
 * @example
 * ```
 * "cron(0 9 * * ? *)"          // daily at 9:00 UTC
 * "cron(0 9 ? * MON-FRI *)"    // weekdays at 9:00
 * "cron(0/15 * * * ? *)"       // every 15 minutes
 * ```
 */
type CronExpression = `cron(${string})`;

/**
 * EventBridge Scheduler schedule expression.
 *
 * - **Rate**: `"rate(5 minutes)"`, `"rate(1 hour)"`, `"rate(1 day)"` — strictly typed units
 * - **Cron**: `"cron(0 9 * * ? *)"` — 6 fields: min hour dom month dow year
 */
export type ScheduleExpression = RateExpression | CronExpression;

// ============ Static config ============

/** Static config extracted at deploy time */
export type CronConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** EventBridge Scheduler schedule expression */
  schedule: ScheduleExpression;
  /** IANA timezone for the schedule (default: UTC) */
  timezone?: Timezone;
};

// ============ Setup args ============

/** Setup factory — receives deps/config/files based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

// ============ Tick handler ============

/** Callback function for cron tick */
export type CronTickFn<C = undefined> =
  (args: SpreadCtx<C>) => Promise<void> | void;

// ============ Handler type ============

/**
 * Handler object created by defineCron.
 * @internal
 */
export type CronHandler<C = any> = {
  readonly __brand: "effortless-cron";
  readonly __spec: CronConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly onTick?: (...args: any[]) => any;
};

// ============ Options ============

/** Options passed to `defineCron()` — resource config only */
type CronOptions = {
  /** EventBridge Scheduler schedule expression: `"rate(5 minutes)"` or `"cron(0 9 * * ? *)"` */
  schedule: ScheduleExpression;
  /** IANA timezone for the schedule (default: UTC). Full autocomplete for all timezones. */
  timezone?: Timezone;
};

// ============ Builder ============

interface CronBuilder<
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): CronBuilder<D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): CronBuilder<D, P2, C, HasFiles>;

  /** Include static files in the Lambda bundle. Chainable — call multiple times. */
  include(glob: string): CronBuilder<D, P, C, true>;

  /** Configure Lambda settings only (memory, timeout, permissions, logLevel) */
  setup(lambda: LambdaOptions): CronBuilder<D, P, C, HasFiles>;

  /** Initialize shared state on cold start. Receives deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>
  ): CronBuilder<D, P, C2, HasFiles>;

  /** Initialize shared state on cold start + configure Lambda settings. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>,
    lambda: LambdaOptions
  ): CronBuilder<D, P, C2, HasFiles>;

  /** Handle errors thrown by onTick */
  onError(
    fn: (args: { error: unknown } & SpreadCtx<C>) => void | Promise<void>
  ): CronBuilder<D, P, C, HasFiles>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): CronBuilder<D, P, C, HasFiles>;

  /** Tick handler — called on each scheduled invocation (terminal) */
  onTick(
    fn: CronTickFn<C>
  ): CronHandler<C>;
}

// ============ Implementation ============

/**
 * Define a cron job — scheduled Lambda invocation via EventBridge Scheduler.
 *
 * @see {@link https://effortless-aws.website/definitions#definecron | Cron reference}
 */
export function defineCron(options: CronOptions): CronBuilder {
  const { schedule, timezone } = options;

  const spec: CronConfig = {
    schedule,
    ...(timezone ? { timezone } : {}),
  };

  const state: {
    spec: CronConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    onTick?: (...args: any[]) => any;
  } = { spec };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): CronHandler => ({
    __brand: "effortless-cron",
    __spec: state.spec,
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.onTick ? { onTick: state.onTick } : {}),
  }) as CronHandler;

  const builder: CronBuilder = {
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
    onTick(fn) {
      state.onTick = fn as any;
      return finalize() as any;
    },
  };

  return builder;
}
