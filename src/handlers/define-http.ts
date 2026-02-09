import type { Permission } from "./permissions";
import type { TableHandler } from "./define-table";
import type { TableClient } from "../runtime/table-client";
import type { AnyParamRef, ResolveParams } from "./param";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTableHandler = TableHandler<any, any, any, any, any>;

/** Maps a deps declaration to resolved runtime client types */
export type ResolveDeps<D> = {
  [K in keyof D]: D[K] extends TableHandler<infer T, any, any, any, any> ? TableClient<T> : never;
};

/** HTTP methods supported by API Gateway */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

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
  /** Response body (will be JSON serialized) */
  body?: unknown;
  /** Response headers */
  headers?: Record<string, string>;
};

/**
 * Configuration options extracted from DefineHttpOptions (without onRequest callback)
 */
export type HttpConfig = {
  /** Handler name. Defaults to export name if not specified */
  name?: string;
  /** HTTP method for the route */
  method: HttpMethod;
  /** Route path (e.g., "/api/users", "/api/users/{id}") */
  path: string;
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout in seconds (default: 30) */
  timeout?: number;
  /** Additional IAM permissions for the Lambda */
  permissions?: Permission[];
};

/**
 * Handler function type for HTTP endpoints
 *
 * @typeParam T - Type of the validated request body (from schema function)
 * @typeParam C - Type of the context/dependencies (from context function)
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 */
export type HttpHandlerFn<T = undefined, C = undefined, D = undefined, P = undefined> =
  (args: { req: HttpRequest }
    & ([T] extends [undefined] ? {} : { data: T })
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { params: ResolveParams<P> })
  ) => Promise<HttpResponse>;

/**
 * Context factory type — conditional on whether params are declared.
 * Without params: `() => C | Promise<C>`
 * With params: `(args: { params: ResolveParams<P> }) => C | Promise<C>`
 */
type ContextFactory<C, P> = [P] extends [undefined]
  ? () => C | Promise<C>
  : (args: { params: ResolveParams<P & {}> }) => C | Promise<C>;

/**
 * Options for defining an HTTP endpoint
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the context/dependencies returned by context function
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 */
export type DefineHttpOptions<
  T = undefined,
  C = undefined,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined
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
   * Factory function to create context/dependencies for the request handler.
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
  /** HTTP request handler function */
  onRequest: HttpHandlerFn<T, C, D, P>;
};

/**
 * Internal handler object created by defineHttp
 * @internal
 */
export type HttpHandler<T = undefined, C = undefined, D = undefined, P = undefined> = {
  readonly __brand: "effortless-http";
  readonly config: HttpConfig;
  readonly schema?: (input: unknown) => T;
  readonly onError?: (error: unknown, req: HttpRequest) => HttpResponse;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly context?: (...args: any[]) => C | Promise<C>;
  readonly deps?: D;
  readonly params?: P;
  readonly onRequest: HttpHandlerFn<T, C, D, P>;
};

/**
 * Define an HTTP endpoint that creates an API Gateway route + Lambda function
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the context/dependencies (inferred from context function)
 * @typeParam D - Type of the deps (from deps declaration)
 * @typeParam P - Type of the params (from params declaration)
 * @param options - Configuration, optional schema, optional context factory, and request handler
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
 *   params: {
 *     dbUrl: param("database-url"),
 *   },
 *   context: async ({ params }) => ({
 *     pool: createPool(params.dbUrl),
 *   }),
 *   onRequest: async ({ req, ctx, params }) => ({
 *     status: 200,
 *     body: { dbUrl: params.dbUrl }
 *   })
 * });
 * ```
 */
export const defineHttp = <
  T = undefined,
  C = undefined,
  D extends Record<string, AnyTableHandler> | undefined = undefined,
  P extends Record<string, AnyParamRef> | undefined = undefined
>(
  options: DefineHttpOptions<T, C, D, P>
): HttpHandler<T, C, D, P> => {
  const { onRequest, onError, context, schema, deps, params, ...config } = options;
  return {
    __brand: "effortless-http",
    config,
    ...(schema ? { schema } : {}),
    ...(onError ? { onError } : {}),
    ...(context ? { context } : {}),
    ...(deps ? { deps } : {}),
    ...(params ? { params } : {}),
    onRequest
  } as HttpHandler<T, C, D, P>;
};
