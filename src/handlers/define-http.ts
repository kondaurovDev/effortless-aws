import type { LambdaWithPermissions, AnyParamRef, ResolveConfig } from "../helpers";
import type { TableHandler } from "./define-table";
import type { TableClient } from "../runtime/table-client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTableHandler = TableHandler<any, any, any, any, any, any>;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T, any, any, any, any> ? TableClient<T> : never;
};

/** HTTP methods supported by API Gateway */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Short content-type aliases for common response formats */
export type ContentType = "json" | "html" | "text" | "css" | "js" | "xml" | "csv" | "svg";

/**
 * Incoming HTTP request object passed to the handler
 */
export type HttpRequest = {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request path (e.g., "/users/123") */
  path: string;
  /** Request headers */
  headers: Record<string, string | undefined>;
  /** Query string parameters */
  query: Record<string, string | undefined>;
  /** Path parameters extracted from route (e.g., {id} -> params.id) */
  params: Record<string, string | undefined>;
  /** Parsed request body (JSON parsed if Content-Type is application/json) */
  body: unknown;
  /** Raw unparsed request body */
  rawBody?: string;
};

/**
 * HTTP response returned from the handler
 */
export type HttpResponse = {
  /** HTTP status code (e.g., 200, 404, 500) */
  status: number;
  /** Response body — JSON-serialized by default, or sent as string when contentType is set */
  body?: unknown;
  /**
   * Short content-type alias. Resolves to full MIME type automatically:
   * - `"json"` → `application/json` (default if omitted)
   * - `"html"` → `text/html; charset=utf-8`
   * - `"text"` → `text/plain; charset=utf-8`
   * - `"css"` → `text/css; charset=utf-8`
   * - `"js"` → `application/javascript; charset=utf-8`
   * - `"xml"` → `application/xml; charset=utf-8`
   * - `"csv"` → `text/csv; charset=utf-8`
   * - `"svg"` → `image/svg+xml; charset=utf-8`
   */
  contentType?: ContentType;
  /** Response headers (use for custom content-types not covered by contentType) */
  headers?: Record<string, string>;
};

/**
 * Configuration options extracted from DefineHttpOptions (without onRequest callback)
 */
export type HttpConfig = LambdaWithPermissions & {
  /** HTTP method for the route */
  method: HttpMethod;
  /** Route path (e.g., "/api/users", "/api/users/{id}") */
  path: string;
};

/**
 * Handler function type for HTTP endpoints
 *
 * @typeParam T - Type of the validated request body (from schema function)
 * @typeParam C - Type of the setup result (from setup function)
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 */
export type HttpHandlerFn<T = undefined, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> =
  (args: { req: HttpRequest }
    & ([T] extends [undefined] ? {} : { data: T })
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { readStatic: (path: string) => string })
  ) => Promise<HttpResponse>;

/**
 * Setup factory type — conditional on whether deps/config are declared.
 * No deps/config: `() => C | Promise<C>`
 * With deps/config: `(args: { deps?, config? }) => C | Promise<C>`
 */
type SetupFactory<C, D, P> = [D | P] extends [undefined]
  ? () => C | Promise<C>
  : (args:
      & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
      & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
    ) => C | Promise<C>;

/**
 * Options for defining an HTTP endpoint
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the setup result returned by setup function
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 */
export type DefineHttpOptions<
  T = undefined,
  C = undefined,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
> = HttpConfig & {
  /**
   * Decode/validate function for the request body.
   * Called with the parsed body; should return typed data or throw on validation failure.
   * When provided, the handler receives validated `data` and invalid requests get a 400 response.
   *
   * Works with any validation library:
   * - Effect: `S.decodeUnknownSync(MySchema)`
   * - Zod: `(body) => myZodSchema.parse(body)`
   */
  schema?: (input: unknown) => T;
  /**
   * Error handler called when schema validation or onRequest throws.
   * Receives the error and request, returns an HttpResponse.
   * If not provided, defaults to 400 for validation errors and 500 for handler errors.
   */
  onError?: (error: unknown, req: HttpRequest) => HttpResponse;
  /**
   * Factory function to initialize shared state for the request handler.
   * Called once on cold start, result is cached and reused across invocations.
   * When deps/params are declared, receives them as argument.
   * Supports both sync and async return values.
   */
  setup?: SetupFactory<C, D, P>;
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
   * Files are accessible at runtime via the `readStatic` callback argument.
   */
  static?: S;
  /** HTTP request handler function */
  onRequest: HttpHandlerFn<T, C, D, P, S>;
};

/**
 * Internal handler object created by defineHttp
 * @internal
 */
export type HttpHandler<T = undefined, C = undefined, D = undefined, P = undefined, S extends string[] | undefined = undefined> = {
  readonly __brand: "effortless-http";
  readonly __spec: HttpConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown, req: HttpRequest) => HttpResponse;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly config?: P;
  readonly static?: string[];
  readonly onRequest: HttpHandlerFn<T, C, D, P, S>;
};

/**
 * Define an HTTP endpoint that creates an API Gateway route + Lambda function
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the setup result (inferred from setup function)
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 * @param options - Configuration, optional schema, optional setup factory, and request handler
 * @returns Handler object used by the deployment system
 *
 * @example Basic GET endpoint
 * ```typescript
 * export const hello = defineHttp({
 *   method: "GET",
 *   path: "/hello",
 *   onRequest: async ({ req }) => ({
 *     status: 200,
 *     body: { message: "Hello World!" }
 *   })
 * });
 * ```
 *
 * @example With SSM parameters
 * ```typescript
 * import { param } from "effortless-aws";
 *
 * export const api = defineHttp({
 *   method: "GET",
 *   path: "/orders",
 *   config: {
 *     dbUrl: param("database-url"),
 *   },
 *   setup: async ({ config }) => ({
 *     pool: createPool(config.dbUrl),
 *   }),
 *   onRequest: async ({ req, ctx, config }) => ({
 *     status: 200,
 *     body: { dbUrl: config.dbUrl }
 *   })
 * });
 * ```
 */
export const defineHttp = <
  T = undefined,
  C = undefined,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined,
  S extends string[] | undefined = undefined
>(
  options: DefineHttpOptions<T, C, D, P, S>
): HttpHandler<T, C, D, P, S> => {
  const { onRequest, onError, setup, schema, deps, config, static: staticFiles, ...__spec } = options;
  return {
    __brand: "effortless-http",
    __spec,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(setup ? { setup } : {}),
    ...(deps ? { deps } : {}),
    ...(config ? { config } : {}),
    ...(staticFiles ? { static: staticFiles } : {}),
    onRequest
  } as HttpHandler<T, C, D, P, S>;
};
