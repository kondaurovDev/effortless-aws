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

/** Branded auth config — created by `enableAuth<A>()` helper, carries session type A */
export type ApiAuthConfig<A = unknown> = AuthOptions<A> & { readonly __sessionType: A };

/** Type of the `enableAuth` helper injected into setup args */
export type EnableAuth = <A = unknown>(options: AuthOptions<A>) => ApiAuthConfig<A>;

/** Runtime implementation of enableAuth — identity function with branded return type */
export const enableAuth: EnableAuth = <A = unknown>(options: AuthOptions<A>): ApiAuthConfig<A> =>
  options as ApiAuthConfig<A>;

/** Extract session type A from ctx.auth if present */
type ExtractAuth<C> = C extends { auth: ApiAuthConfig<infer A> } ? A : undefined;

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

/** Spread ctx into route args: Omit auth config, add AuthHelpers if present */
type SpreadCtx<C> =
  & ([C] extends [undefined] ? {} : Omit<C & {}, 'auth'>)
  & ([ExtractAuth<C>] extends [undefined] ? {} : { auth: AuthHelpers<ExtractAuth<C>> });

/** Callback args available inside each route — ctx is spread into args */
type RouteArgs<C, ST> =
  & SpreadCtx<C>
  & { req: HttpRequest; input: unknown; ok: OkHelper; fail: FailHelper }
  & ([ST] extends [true] ? { stream: ResponseStream } : {});

/** Route handler function */
type RouteHandler<C, ST> = (args: RouteArgs<C, ST>) => Promise<HttpResponse | void> | HttpResponse | void;

/** Callback args with typed input from schema validation */
type TypedRouteArgs<C, ST, S extends StandardSchemaV1> =
  & SpreadCtx<C>
  & { req: HttpRequest; input: StandardSchemaV1.InferOutput<S>; ok: OkHelper; fail: FailHelper }
  & ([ST] extends [true] ? { stream: ResponseStream } : {});

/** Route handler function with typed input */
type TypedRouteHandler<C, ST, S extends StandardSchemaV1> = (args: TypedRouteArgs<C, ST, S>) => Promise<HttpResponse | void> | HttpResponse | void;

/** Route definition with typed schema input */
type TypedRouteDef<S extends StandardSchemaV1 = StandardSchemaV1> = {
  path: `/${string}`;
  input: S;
  public?: boolean;
  cache?: CacheOptions;
};

/** Route definition without schema */
type RouteDef = {
  path: `/${string}`;
  public?: boolean;
  cache?: CacheOptions;
};

/** Route options for all methods */
type RouteOptions = { public?: boolean };
/** Route options for GET — supports caching */
type GetRouteOptions = RouteOptions & { cache?: CacheOptions };

// ============ Setup args ============

/** Setup factory — receives deps/config/files/enableAuth based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & { enableAuth: EnableAuth; ok: OkHelper; fail: FailHelper }
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/** Validate that setup return type does not use reserved property names */
type ValidateSetupReturn<C> = C & { [K in ReservedKeys]?: never };

// ============ Static config ============

/** Static config extracted by AST (no runtime callbacks) */
export type ApiConfig = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: `/${string}`;
  /** Enable response streaming. When true, the Lambda Function URL uses RESPONSE_STREAM invoke mode. */
  stream?: boolean;
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
};

// ============ ApiRoutes — returned after first route method ============

/**
 * Finalized API handler with route-adding methods.
 * Has `__brand` so CLI discovers it. Each `.get()/.post()` adds a route and returns self.
 */
export interface ApiRoutes<C = undefined, ST extends boolean = false> extends ApiHandler<C> {
  get<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  get(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  get(path: `/${string}`, handler: RouteHandler<C, ST>, options?: GetRouteOptions): ApiRoutes<C, ST>;

  post<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  post(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  post(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  put<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  put(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  put(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  patch<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  patch(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  patch(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  delete<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  delete(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  delete(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;
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
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): ApiBuilder<D2, P, C, ST, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): ApiBuilder<D, P2, C, ST, HasFiles>;

  /** Include static files by glob pattern */
  include(glob: string): ApiBuilder<D, P, C, ST, true>;

  /** Configure Lambda settings only (no init function) */
  setup(lambda: LambdaOptions): ApiBuilder<D, P, C, ST, HasFiles>;
  /** Initialize shared state on cold start. Receives deps/config/files based on what was declared. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => ValidateSetupReturn<C2> | Promise<ValidateSetupReturn<C2>>
  ): ApiBuilder<D, P, C2, ST, HasFiles>;
  /** Initialize shared state on cold start with Lambda config. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => ValidateSetupReturn<C2> | Promise<ValidateSetupReturn<C2>>,
    lambda: LambdaOptions,
  ): ApiBuilder<D, P, C2, ST, HasFiles>;

  /** Handle errors thrown by routes */
  onError(
    fn: (args: { error: unknown; req: HttpRequest; ok: OkHelper; fail: FailHelper } & SpreadCtx<C>) => HttpResponse | Promise<HttpResponse>
  ): ApiBuilder<D, P, C, ST, HasFiles>;

  /** Cleanup callback — runs after each invocation, before Lambda freezes */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): ApiBuilder<D, P, C, ST, HasFiles>;

  get<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  get(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  get(path: `/${string}`, handler: RouteHandler<C, ST>, options?: GetRouteOptions): ApiRoutes<C, ST>;

  post<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  post(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  post(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  put<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  put(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  put(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  patch<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  patch(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  patch(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;

  delete<S extends StandardSchemaV1>(def: TypedRouteDef<S>, handler: TypedRouteHandler<C, ST, S>): ApiRoutes<C, ST>;
  delete(def: RouteDef, handler: RouteHandler<C, ST>): ApiRoutes<C, ST>;
  delete(path: `/${string}`, handler: RouteHandler<C, ST>, options?: RouteOptions): ApiRoutes<C, ST>;
}

// ============ Implementation ============

/**
 * Define an API with typed routes using a builder pattern.
 *
 * @see {@link https://effortless-aws.website/use-cases/http-api | HTTP API guide}
 *
 * @example
 * ```typescript
 * export const api = defineApi({ basePath: "/api", timeout: "30s" })
 *   .deps(() => ({ users }))
 *   .config(({ defineSecret }) => ({ dbUrl: defineSecret() }))
 *   .setup(async ({ deps, config, enableAuth }) => ({
 *     users: deps.users,
 *     auth: enableAuth<Session>({ secret: config.dbUrl }),
 *   }))
 *   .onError(({ error, fail }) => fail(String(error), 500))
 *   .get("/me", async ({ users, auth, ok }) => ok(auth.session))
 *   .post("/login", async ({ auth, ok }) => ok(await auth.createSession()), { public: true })
 * ```
 */
export function defineApi<const O extends ApiOptions>(
  options: O,
): ApiBuilder<undefined, undefined, undefined, O["stream"] extends true ? true : false, false>;
export function defineApi(
  options: ApiOptions,
): ApiBuilder {
  const { basePath, stream } = options;

  const state: {
    spec: ApiConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    routes: RouteEntry[];
  } = {
    spec: {
      basePath,
      ...(stream ? { stream } : {}),
    },
    routes: [],
  };

  const addRoute = (method: HttpMethod, path: string, handler: Function, opts?: GetRouteOptions, schema?: unknown) => {
    const routeCache = opts?.cache != null
      ? resolveCache(opts.cache)
      : undefined;

    state.routes.push({
      method,
      path,
      onRequest: handler as any,
      ...(schema ? { schema } : {}),
      ...(opts?.public ? { public: true } : {}),
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
      ...(state.deps ? { deps: state.deps } : {}),
      ...(state.config ? { config: state.config } : {}),
      ...(state.static ? { static: state.static } : {}),
    };

    // Add route methods to the finalized handler
    for (const m of ["get", "post", "put", "patch", "delete"] as const) {
      handler[m] = (pathOrDef: any, handlerOrFn: any, opts?: any) => {
        if (typeof pathOrDef === "string") {
          // Old: .post("/path", handler, opts?)
          addRoute(m.toUpperCase() as HttpMethod, pathOrDef, handlerOrFn, opts);
        } else {
          // New: .post({ path, input?, public?, cache? }, handler)
          const def = pathOrDef;
          addRoute(m.toUpperCase() as HttpMethod, def.path, handlerOrFn, { ...(def.public ? { public: def.public } : {}), ...(def.cache ? { cache: def.cache } : {}) }, def.input);
        }
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
    get(pathOrDef: any, handlerOrFn: any, opts?: any) {
      if (typeof pathOrDef === "string") { addRoute("GET", pathOrDef, handlerOrFn, opts); }
      else { addRoute("GET", pathOrDef.path, handlerOrFn, { ...(pathOrDef.public ? { public: pathOrDef.public } : {}), ...(pathOrDef.cache ? { cache: pathOrDef.cache } : {}) }, pathOrDef.input); }
      return finalize() as any;
    },
    post(pathOrDef: any, handlerOrFn: any, opts?: any) {
      if (typeof pathOrDef === "string") { addRoute("POST", pathOrDef, handlerOrFn, opts); }
      else { addRoute("POST", pathOrDef.path, handlerOrFn, { ...(pathOrDef.public ? { public: pathOrDef.public } : {}), ...(pathOrDef.cache ? { cache: pathOrDef.cache } : {}) }, pathOrDef.input); }
      return finalize() as any;
    },
    put(pathOrDef: any, handlerOrFn: any, opts?: any) {
      if (typeof pathOrDef === "string") { addRoute("PUT", pathOrDef, handlerOrFn, opts); }
      else { addRoute("PUT", pathOrDef.path, handlerOrFn, { ...(pathOrDef.public ? { public: pathOrDef.public } : {}), ...(pathOrDef.cache ? { cache: pathOrDef.cache } : {}) }, pathOrDef.input); }
      return finalize() as any;
    },
    patch(pathOrDef: any, handlerOrFn: any, opts?: any) {
      if (typeof pathOrDef === "string") { addRoute("PATCH", pathOrDef, handlerOrFn, opts); }
      else { addRoute("PATCH", pathOrDef.path, handlerOrFn, { ...(pathOrDef.public ? { public: pathOrDef.public } : {}), ...(pathOrDef.cache ? { cache: pathOrDef.cache } : {}) }, pathOrDef.input); }
      return finalize() as any;
    },
    delete(pathOrDef: any, handlerOrFn: any, opts?: any) {
      if (typeof pathOrDef === "string") { addRoute("DELETE", pathOrDef, handlerOrFn, opts); }
      else { addRoute("DELETE", pathOrDef.path, handlerOrFn, { ...(pathOrDef.public ? { public: pathOrDef.public } : {}), ...(pathOrDef.cache ? { cache: pathOrDef.cache } : {}) }, pathOrDef.input); }
      return finalize() as any;
    },
  };

  return builder;
}
