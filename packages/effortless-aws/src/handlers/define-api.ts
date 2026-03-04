import type { LambdaWithPermissions, AnyParamRef, ResolveConfig } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";
import type { HttpRequest, HttpResponse } from "./shared";

/** GET route handler — no schema, no data */
export type ApiGetHandlerFn<
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> =
  (args: { req: HttpRequest }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<HttpResponse> | HttpResponse;

/** POST handler — with typed data from schema */
export type ApiPostHandlerFn<
  T = undefined,
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> =
  (args: { req: HttpRequest }
    & ([T] extends [undefined] ? {} : { data: T })
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => Promise<HttpResponse> | HttpResponse;

/** Setup factory — receives deps/config/files when declared */
type SetupFactory<C, D, P, S extends string[] | undefined = undefined> =
  (args:
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    & ([S] extends [undefined] ? {} : { files: StaticFiles })
  ) => C | Promise<C>;

/** Static config extracted by AST (no runtime callbacks) */
export type ApiConfig = LambdaWithPermissions & {
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: string;
};

/**
 * Options for defining a CQRS-style API endpoint.
 *
 * - `get` routes handle queries (path-based routing, no body)
 * - `post` handles commands (single entry point, discriminated union via `schema`)
 */
export type DefineApiOptions<
  T = undefined,
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
> = LambdaWithPermissions & {
  /** Base path prefix for all routes (e.g., "/api") */
  basePath: string;
  /**
   * Factory function to initialize shared state.
   * Called once on cold start, result is cached and reused across invocations.
   */
  setup?: SetupFactory<C, D, P, S>;
  /** Dependencies on other handlers (tables, queues, etc.) */
  deps?: D;
  /** SSM Parameter Store parameters */
  config?: P;
  /** Static file glob patterns to bundle into the Lambda ZIP */
  static?: S;
  /** Error handler called when schema validation or handler throws */
  onError?: (error: unknown, req: HttpRequest) => HttpResponse;

  /** GET routes — query handlers keyed by relative path (e.g., "/users/{id}") */
  get?: Record<string, ApiGetHandlerFn<C, D, P, S>>;

  /**
   * Schema for POST body validation. Use with discriminated unions:
   * ```typescript
   * schema: Action.parse,
   * post: async ({ data }) => { switch (data.action) { ... } }
   * ```
   */
  schema?: (input: unknown) => T;
  /** POST handler — single entry point for commands */
  post?: ApiPostHandlerFn<T, C, D, P, S>;
};

/** Internal handler object created by defineApi */
export type ApiHandler<
  T = undefined,
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> = {
  readonly __brand: "effortless-api";
  readonly __spec: ApiConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown, req: HttpRequest) => HttpResponse;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly config?: P;
  readonly static?: string[];
  readonly get?: Record<string, ApiGetHandlerFn<C, D, P, S>>;
  readonly post?: ApiPostHandlerFn<T, C, D, P, S>;
};

/**
 * Define a CQRS-style API with typed GET routes and POST commands.
 *
 * GET routes handle queries — path-based routing, no request body.
 * POST handles commands — single entry point with discriminated union schema.
 * Deploys as a single Lambda (fat Lambda) with one API Gateway catch-all route.
 *
 * @example
 * ```typescript
 * export default defineApi({
 *   basePath: "/api",
 *   deps: { users },
 *
 *   get: {
 *     "/users": async ({ req, deps }) => ({
 *       status: 200,
 *       body: await deps.users.scan()
 *     }),
 *     "/users/{id}": async ({ req, deps }) => ({
 *       status: 200,
 *       body: await deps.users.get(req.params.id)
 *     }),
 *   },
 *
 *   schema: Action.parse,
 *   post: async ({ data, deps }) => {
 *     switch (data.action) {
 *       case "create": return { status: 201, body: await deps.users.put(data) }
 *       case "delete": return { status: 200, body: await deps.users.delete(data.id) }
 *     }
 *   },
 * })
 * ```
 */
export const defineApi = <
  T = undefined,
  C = undefined,
  D extends Record<string, AnyDepHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineApiOptions<T, C, D, P, S>
): ApiHandler<T, C, D, P, S> => {
  const { get, post, schema, onError, setup, deps, config, static: staticFiles, ...__spec } = options;
  return {
    __brand: "effortless-api",
    __spec,
    ...(get ? { get } : {}),
    ...(post ? { post } : {}),
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
  } as ApiHandler<T, C, D, P, S>;
};
