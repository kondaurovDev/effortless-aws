import type { Permission } from "./permissions";

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
 */
export type HttpHandlerFn<T = undefined, C = undefined> =
  (args: { req: HttpRequest }
    & ([T] extends [undefined] ? {} : { data: T })
    & ([C] extends [undefined] ? {} : { ctx: C })
  ) => Promise<HttpResponse>;

/**
 * Options for defining an HTTP endpoint
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the context/dependencies returned by context function
 *
 * @example Without context
 * ```typescript
 * export const getUsers = defineHttp({
 *   method: "GET",
 *   path: "/api/users",
 *   onRequest: async ({ req }) => ({
 *     status: 200,
 *     body: { users: [] }
 *   })
 * });
 * ```
 *
 * @example With schema validation (Effect/Schema)
 * ```typescript
 * import { Schema as S } from "effect"
 *
 * export const createUser = defineHttp({
 *   method: "POST",
 *   path: "/api/users",
 *   schema: S.decodeUnknownSync(S.Struct({ name: S.String, email: S.String })),
 *   onRequest: async ({ req, data }) => {
 *     // data is typed as { readonly name: string; readonly email: string }
 *     return { status: 201, body: data };
 *   }
 * });
 * ```
 *
 * @example With context (e.g., Effect runtime)
 * ```typescript
 * export const createOrder = defineHttp<typeof orderRuntime>({
 *   method: "POST",
 *   path: "/api/orders",
 *   context: () => ManagedRuntime.make(
 *     Layer.mergeAll(ConfigLive, DbClientLive)
 *   ),
 *   onRequest: async ({ req, ctx }) => {
 *     const result = await ctx.runPromise(createOrderEffect(req.body));
 *     return { status: 201, body: result };
 *   }
 * });
 * ```
 */
export type DefineHttpOptions<T = undefined, C = undefined> = HttpConfig & {
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
   * Factory function to create context/dependencies for the request handler.
   * Called once on cold start, result is cached and reused across invocations.
   */
  context?: () => C;
  /** HTTP request handler function */
  onRequest: HttpHandlerFn<T, C>;
};

/**
 * Internal handler object created by defineHttp
 * @internal
 */
export type HttpHandler<T = undefined, C = undefined> = {
  readonly __brand: "effortless-http";
  readonly config: HttpConfig;
  readonly schema?: (input: unknown) => T;
  readonly context?: () => C;
  readonly onRequest: HttpHandlerFn<T, C>;
};

/**
 * Define an HTTP endpoint that creates an API Gateway route + Lambda function
 *
 * @typeParam T - Type of the validated request body (inferred from schema function)
 * @typeParam C - Type of the context/dependencies (inferred from context function)
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
 * @example POST endpoint with schema validation
 * ```typescript
 * import { Schema as S } from "effect"
 *
 * export const createUser = defineHttp({
 *   method: "POST",
 *   path: "/users",
 *   schema: S.decodeUnknownSync(S.Struct({ name: S.String, email: S.String })),
 *   onRequest: async ({ data }) => {
 *     // data is typed as { readonly name: string; readonly email: string }
 *     return { status: 201, body: { id: "123", ...data } };
 *   }
 * });
 * ```
 *
 * @example With Effect runtime context
 * ```typescript
 * export const processPayment = defineHttp<typeof paymentRuntime>({
 *   method: "POST",
 *   path: "/payments",
 *   context: () => ManagedRuntime.make(
 *     Layer.mergeAll(ConfigLive, StripeClientLive)
 *   ),
 *   onRequest: async ({ req, ctx }) => {
 *     const result = await ctx.runPromise(
 *       processPaymentEffect(req.body)
 *     );
 *     return { status: 200, body: result };
 *   }
 * });
 * ```
 */
export const defineHttp = <T = undefined, C = undefined>(
  options: DefineHttpOptions<T, C>
): HttpHandler<T, C> => {
  const { onRequest, context, schema, ...config } = options;
  return {
    __brand: "effortless-http",
    config,
    ...(schema ? { schema } : {}),
    ...(context ? { context } : {}),
    onRequest
  } as HttpHandler<T, C>;
};
