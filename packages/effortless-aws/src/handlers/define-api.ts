import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { LambdaWithPermissions, AnySecretRef, ResolveConfig, Duration, ConfigFactory, LambdaOptions } from "./handler-options";
import { resolveConfigFactory, toSeconds } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles, ResponseStream } from "./shared";
import type { HttpRequest, HttpResponse } from "./shared";
import type { AuthHelpers } from "./auth";

// ============ Auth types ============

/** Auth config options (user-facing) */
export type AuthOptions<A = unknown> = {
  /** HMAC secret for signing session cookies. Use `secret()` or `param()` in config. */
  secret: string;
  /** Default session lifetime (default: "7d"). */
  expiresIn?: Duration;
  /** Optional API token strategy for external clients. */
  apiToken?: {
    /** HTTP header to read the token from. Default: "authorization" (strips "Bearer " prefix). */
    header?: string;
    /** Verify the token value and return session data, or null if invalid. */
    verify: (value: string) => A | null | Promise<A | null>;
    /** Cache verified token results for this duration. */
    cacheTtl?: Duration;
  };
};

/** Property names reserved by the framework — cannot be used in setup return */
type ReservedKeys = 'req' | 'input' | 'stream' | 'ok' | 'fail';

// ============ Response helpers ============

/** Success response helper: `ok({ data })` → `{ status: 200, body: { data } }` */
export type OkHelper = (body?: unknown, status?: number) => HttpResponse;
/** Error response helper: `fail("message")` → `{ status: 400, body: { error: "message" } }` */
export type FailHelper = (message: string, status?: number) => HttpResponse;

// ============ Route types ============

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Cache options for a GET route. Duration shorthand (e.g. "30s", "5m") or object for fine-grained control. */
export type CacheOptions = Duration | {
  ttl: Duration;
  swr?: Duration;
  scope?: "public" | "private";
};

/** Resolved cache config with numeric seconds */
type ResolvedCache =
  | { private?: false; ttl: number; swr: number }
  | { private: true; ttl: number };

/** Resolve CacheOptions into numeric seconds. Shorthand = public with swr = ttl * 2. */
const resolveCache = (cache: CacheOptions): ResolvedCache => {
  if (typeof cache === "number" || typeof cache === "string") {
    const ttl = toSeconds(cache);
    return { ttl, swr: ttl * 2 };
  }
  const ttl = toSeconds(cache.ttl);
  if (cache.scope === "private") {
    return { private: true, ttl };
  }
  return {
    ttl,
    swr: cache.swr != null ? toSeconds(cache.swr) : ttl * 2,
  };
};

/** Parsed route definition stored at runtime */
export type RouteEntry = {
  method: HttpMethod;
  path: string;
  onRequest: (...args: any[]) => any;
  schema?: unknown;
  public?: boolean;
  cache?: ResolvedCache;
};

/** Spread ctx into route args, add AuthHelpers if A is set */
type SpreadCtx<C, A = undefined> =
  & ([C] extends [undefined] ? {} : C & {})
  & ([A] extends [undefined] ? {} : { auth: AuthHelpers<A> });

/** Infer validated output type from a Standard Schema, or fall back to unknown */
type InferInput<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown;

/** Callback args available inside each route — ctx is spread into args */
type RouteArgs<C, ST, A = undefined, S = undefined> =
  & SpreadCtx<C, A>
  & { req: HttpRequest; input: InferInput<S>; ok: OkHelper; fail: FailHelper }
  & ([ST] extends [true] ? { stream: ResponseStream } : {});

/** Route handler function */
type RouteHandler<C, ST, A = undefined, S = undefined> = (args: RouteArgs<C, ST, A, S>) => Promise<HttpResponse | void> | HttpResponse | void;

/** Route definition — pass `input` for typed schema validation */
type RouteDef<S extends StandardSchemaV1 | undefined = undefined> = {
  path: `/${string}`;
  input?: S;
  public?: boolean;
  cache?: CacheOptions;
};

// ============ Setup args ============

/** Setup factory — receives deps/config/files based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & { ok: OkHelper; fail: FailHelper }
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/** Auth factory args — receives config/deps based on what was declared */
type AuthArgs<D, P> =
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> });

/** Validate that setup return type does not use reserved property names */
type ValidateSetupReturn<C> = C & { [K in ReservedKeys]?: never };

// ============ Static config ============

/** External runtime configuration for non-TypeScript handlers (e.g., Go) */
export type ExternalRuntime = {
  /** Runtime language identifier */
  lang: "go";
  /** Path to the handler source directory (relative to project root) */
  handler: string;
};

/** Static config extracted by AST (no runtime callbacks) */
export type ApiConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: `/${string}`;
  /** Enable response streaming. When true, the Lambda Function URL uses RESPONSE_STREAM invoke mode. */
  stream?: boolean;
  /** External runtime — when set, handler code is compiled externally (e.g., Go binary) instead of bundled with esbuild. */
  runtime?: ExternalRuntime;
  /** Path to external handler directory (relative to project root). Use `effortless generate` to scaffold handler files. */
  handler?: string;
};

// ============ Internal handler object ============

/** Internal handler object created by defineApi */
export type ApiHandler<C = undefined> = {
  readonly __brand: "effortless-api";
  readonly __spec: ApiConfig;
  readonly onError?: (...args: any[]) => any | Promise<any>;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly routes?: RouteEntry[];
};

// ============ Builder options (plain values, no inference) ============

/** Options passed to `defineApi()` */
type ApiOptions = {
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: `/${string}`;
  /** Enable response streaming. When true, routes receive a `stream` arg for SSE. */
  stream?: boolean;
  /** External runtime — handler code is compiled externally (e.g., Go binary) instead of bundled with esbuild. */
  runtime?: ExternalRuntime;
  /** Path to external handler directory (relative to project root). Use `effortless generate` to scaffold handler files. */
  handler?: string;
};

// ============ ApiRoutes — returned after first route method ============

/**
 * Finalized API handler with route-adding methods.
 * Has `__brand` so CLI discovers it. Each `.get()/.post()` adds a route and returns self.
 */
export interface ApiRoutes<C = undefined, ST extends boolean = false, A = undefined> extends ApiHandler<C> {
  get<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  post<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  put<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  patch<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  delete<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
}

// ============ Builder ============

/**
 * Builder interface for defining API handlers.
 *
 * Each method sets exactly one generic, so inference happens one step at a time.
 * This prevents cascading type errors when one property has a mistake.
 */
interface ApiBuilder<
  D = undefined,
  P = undefined,
  C = undefined,
  ST extends boolean = false,
  HasFiles extends boolean = false,
  A = undefined,
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): ApiBuilder<D2, P, C, ST, HasFiles, A>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): ApiBuilder<D, P2, C, ST, HasFiles, A>;

  /** Include static files by glob pattern */
  include(glob: string): ApiBuilder<D, P, C, ST, true, A>;

  /** Configure session-based authentication. Receives resolved config/deps. */
  auth<A2>(
    fn: (args: AuthArgs<D, P>) => AuthOptions<A2> | Promise<AuthOptions<A2>>
  ): ApiBuilder<D, P, C, ST, HasFiles, A2>;

  /** Configure Lambda settings only (no init function) */
  setup(lambda: LambdaOptions): ApiBuilder<D, P, C, ST, HasFiles, A>;
  /** Initialize shared state on cold start. Receives deps/config/files based on what was declared. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => ValidateSetupReturn<C2> | Promise<ValidateSetupReturn<C2>>
  ): ApiBuilder<D, P, C2, ST, HasFiles, A>;
  /** Initialize shared state on cold start with Lambda config. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => ValidateSetupReturn<C2> | Promise<ValidateSetupReturn<C2>>,
    lambda: LambdaOptions,
  ): ApiBuilder<D, P, C2, ST, HasFiles, A>;

  /** Handle errors thrown by routes */
  onError(
    fn: (args: { error: unknown; req: HttpRequest; ok: OkHelper; fail: FailHelper } & SpreadCtx<C, A>) => HttpResponse | Promise<HttpResponse>
  ): ApiBuilder<D, P, C, ST, HasFiles, A>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C, A>) => void | Promise<void>
  ): ApiBuilder<D, P, C, ST, HasFiles, A>;

  /** Finalize as infra-only handler (no routes). Use with `handler` option for external handler code. */
  build(): ApiHandler<C>;

  get<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  post<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  put<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  patch<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
  delete<S extends StandardSchemaV1 | undefined = undefined>(def: RouteDef<S>, handler: RouteHandler<C, ST, A, S>): ApiRoutes<C, ST, A>;
}

// ============ Implementation ============

/**
 * Define an API with typed routes using a builder pattern.
 *
 * @see {@link https://effortless-aws.website/use-cases/http-api | HTTP API guide}
 *
 * @example
 * ```typescript
 * export const api = defineApi({ basePath: "/api" })
 *   .deps(() => ({ users }))
 *   .config(({ defineSecret }) => ({ authSecret: defineSecret() }))
 *   .auth<Session>(({ config }) => ({ secret: config.authSecret, expiresIn: "1h" }))
 *   .get({ path: "/me" }, async ({ users, auth, ok }) => ok(auth.session))
 *   .post({ path: "/login", public: true }, async ({ auth, ok }) => ok(await auth.createSession()))
 * ```
 */
export function defineApi<const O extends ApiOptions>(
  options: O,
): O["runtime"] extends ExternalRuntime ? ApiHandler : ApiBuilder<undefined, undefined, undefined, O["stream"] extends true ? true : false, false>;
export function defineApi(
  options: ApiOptions,
): ApiBuilder | ApiHandler {
  const { basePath, stream, runtime, handler } = options;

  // External runtime (e.g., Go) — no TS routes, return handler immediately
  if (runtime) {
    return {
      __brand: "effortless-api" as const,
      __spec: { basePath, ...(stream ? { stream } : {}), runtime },
      routes: [],
    } satisfies ApiHandler;
  }

  const state: {
    spec: ApiConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    authFn?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    routes: RouteEntry[];
  } = {
    spec: {
      basePath,
      ...(stream ? { stream } : {}),
      ...(runtime ? { runtime } : {}),
      ...(handler ? { handler } : {}),
    },
    routes: [],
  };

  const addRoute = (method: HttpMethod, def: { path: string; input?: unknown; public?: boolean; cache?: CacheOptions }, handler: Function) => {
    const routeCache = def.cache != null
      ? resolveCache(def.cache)
      : undefined;

    state.routes.push({
      method,
      path: def.path,
      onRequest: handler as any,
      ...(def.input ? { schema: def.input } : {}),
      ...(def.public ? { public: true } : {}),
      ...(routeCache ? { cache: routeCache } : {}),
    });
  };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): ApiRoutes => {
    const handler: any = {
      __brand: "effortless-api",
      __spec: state.spec,
      routes: state.routes,
      ...(state.onError ? { onError: state.onError } : {}),
      ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
      ...(state.setup ? { setup: state.setup } : {}),
      ...(state.authFn ? { authFn: state.authFn } : {}),
      ...(state.deps ? { deps: state.deps } : {}),
      ...(state.config ? { config: state.config } : {}),
      ...(state.static ? { static: state.static } : {}),
    };

    // Add route methods to the finalized handler
    for (const m of ["get", "post", "put", "patch", "delete"] as const) {
      handler[m] = (def: any, fn: any) => {
        addRoute(m.toUpperCase() as HttpMethod, def, fn);
        handler.routes = state.routes;
        return handler;
      };
    }

    return handler as ApiRoutes;
  };

  const builder: ApiBuilder = {
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
    auth(fn: any) {
      state.authFn = fn;
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
    build() { return finalize() as any; },
    get(def: any, fn: any) { addRoute("GET", def, fn); return finalize() as any; },
    post(def: any, fn: any) { addRoute("POST", def, fn); return finalize() as any; },
    put(def: any, fn: any) { addRoute("PUT", def, fn); return finalize() as any; },
    patch(def: any, fn: any) { addRoute("PATCH", def, fn); return finalize() as any; },
    delete(def: any, fn: any) { addRoute("DELETE", def, fn); return finalize() as any; },
  };

  return builder;
}
