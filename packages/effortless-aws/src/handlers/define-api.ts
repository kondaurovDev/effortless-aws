import type { LambdaWithPermissions, AnySecretRef, ResolveConfig, Duration, ConfigFactory } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
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
type ReservedKeys = 'req' | 'input' | 'stream';

// ============ Route types ============

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Parsed route definition stored at runtime */
export type RouteEntry = {
  method: HttpMethod;
  path: string;
  onRequest: (...args: any[]) => any;
  public?: boolean;
};

/** Spread ctx into route args: Omit auth config, add AuthHelpers if present */
type SpreadCtx<C> =
  & ([C] extends [undefined] ? {} : Omit<C & {}, 'auth'>)
  & ([ExtractAuth<C>] extends [undefined] ? {} : { auth: AuthHelpers<ExtractAuth<C>> });

/** Callback args available inside each route — ctx is spread into args */
type RouteArgs<C, ST> =
  & SpreadCtx<C>
  & { req: HttpRequest; input: unknown }
  & ([ST] extends [true] ? { stream: ResponseStream } : {});

/** Route definition with typed args */
type RouteDefinition<C, ST> = {
  path: `${HttpMethod} /${string}`;
  onRequest: (args: RouteArgs<C, ST>) => Promise<HttpResponse | void> | HttpResponse | void;
  public?: boolean;
};

// ============ Setup factory ============

/** Validate that setup return type does not use reserved property names */
type ValidateSetupReturn<C> = C & { [K in ReservedKeys]?: never };

/** Setup factory — receives deps/config/files/enableAuth when declared */
type SetupFactory<C, D, P, S extends string[] | undefined = undefined> =
  (args:
    & { enableAuth: EnableAuth }
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => ValidateSetupReturn<C> | Promise<ValidateSetupReturn<C>>;

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

// ============ Options ============

export type DefineApiOptions<
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnySecretRef> | undefined = undefined,
  S extends string[] | undefined = undefined,
  ST extends boolean | undefined = undefined,
> = {
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: `/${string}`;
  /** Enable response streaming. When true, routes receive a `stream` arg for SSE. */
  stream?: ST;
  /** Factory function to initialize shared state. Called once on cold start. */
  setup?: SetupFactory<C, NoInfer<D>, NoInfer<P>, NoInfer<S>>;
  /** Dependencies on other handlers (tables, queues, etc.): `deps: () => ({ users })` */
  deps?: () => D & {};
  /** SSM Parameter Store parameters. Receives `{ defineSecret }` helper. */
  config?: ConfigFactory<P>;
  /** Static file glob patterns to bundle into the Lambda ZIP */
  static?: S;
  /** Error handler called when a route throws */
  onError?: (args: { error: unknown; req: HttpRequest } & SpreadCtx<C>) => HttpResponse;
  /** Called after each invocation completes */
  onAfterInvoke?: (args: SpreadCtx<C>) => void | Promise<void>;

  /** Route definitions — plain array of route objects */
  routes?: RouteDefinition<C, ST>[];
};

// ============ Internal handler object ============

/** Internal handler object created by defineApi */
export type ApiHandler<C = undefined> = {
  readonly __brand: "effortless-api";
  readonly __spec: ApiConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onAfterInvoke?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly routes?: RouteEntry[];
};

/**
 * Define an API with typed routes.
 *
 * Setup return is spread into route args — all properties are directly accessible.
 * Reserved names (`req`, `input`, `stream`) cannot be used in setup return.
 * Auth is configured via an `auth` property in setup return — runtime replaces it with `AuthHelpers`.
 *
 * @example
 * ```typescript
 * export default defineApi({
 *   basePath: "/api",
 *   deps: () => ({ users }),
 *   setup: ({ deps }) => ({
 *     users: deps.users,
 *     auth: {
 *       schema: unsafeAs<Session>(),
 *       apiToken: {
 *         verify: async (value) => {
 *           const user = await deps.users.query({ pk: value });
 *           return user[0] ? { userId: user[0].sk } : null;
 *         },
 *       },
 *     },
 *   }),
 *   routes: [
 *     {
 *       path: "GET /me",
 *       onRequest: async ({ users, auth }) => ({
 *         status: 200,
 *         body: { user: await users.get(auth.session.userId) },
 *       }),
 *     },
 *   ],
 * })
 * ```
 */
export const defineApi = () => <
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnySecretRef> | undefined = undefined,
  S extends string[] | undefined = undefined,
  ST extends boolean | undefined = undefined,
>(
  options: DefineApiOptions<C, D, P, S, ST>
): ApiHandler<C> => {
  const { routes, onError, onAfterInvoke, setup, deps, config: configFactory, static: staticFiles, ...__spec } = options;
  const config = configFactory ? resolveConfigFactory(configFactory) : undefined;
  const parsed = routes ? routes.map(parseRoute) : undefined;
  return {
    __brand: "effortless-api",
    __spec,
    ...(parsed ? { routes: parsed } : {}),
    ...(onError ? { onError } : {}),
    ...(onAfterInvoke ? { onAfterInvoke } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
  } as ApiHandler<C>;
};

/** Parse "METHOD /path" into RouteEntry */
const parseRoute = (route: { path: string; onRequest: Function; public?: boolean }): RouteEntry => {
  const spaceIdx = route.path.indexOf(" ");
  const method = route.path.slice(0, spaceIdx) as HttpMethod;
  const path = route.path.slice(spaceIdx + 1);
  return {
    method,
    path,
    onRequest: route.onRequest as any,
    ...(route.public ? { public: true } : {}),
  };
};
