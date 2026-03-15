import type { ApiHandler } from "../handlers/define-api";
import type { ContentType, ResponseStream } from "../handlers/shared";
import { AUTH_COOKIE_NAME } from "../handlers/auth";
import { createHandlerRuntime } from "./handler-utils";

const CONTENT_TYPE_MAP: Record<ContentType, string> = {
  json: "application/json",
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
};

const parseBody = (body: string | undefined, isBase64: boolean): unknown => {
  if (!body) return undefined;
  const decoded = isBase64 ? Buffer.from(body, "base64").toString("utf-8") : body;
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
};

type LambdaEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  httpMethod?: string;
  path?: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
};

// ============ Route matching ============

type RouteMatcher = {
  regex: RegExp;
  paramNames: string[];
  handler: Function;
};

const buildGetMatchers = (
  routes: Record<string, Function>,
  basePath: string
): RouteMatcher[] =>
  Object.entries(routes).map(([pattern, handler]) => {
    const fullPattern = (basePath + pattern).replace(/\/\/+/g, "/");
    const paramNames: string[] = [];
    const regexStr = fullPattern.replace(/\{(\w+)\}/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    };
  });

const matchRoute = (
  matchers: RouteMatcher[],
  path: string
): { handler: Function; params: Record<string, string> } | null => {
  for (const matcher of matchers) {
    const match = path.match(matcher.regex);
    if (match) {
      const params: Record<string, string> = {};
      matcher.paramNames.forEach((name, i) => {
        params[name] = match[i + 1]!;
      });
      return { handler: matcher.handler, params };
    }
  }
  return null;
};

// ============ Response helpers ============

const toResult = (r: { status: number; body?: unknown; contentType?: ContentType; headers?: Record<string, string>; binary?: boolean }) => {
  const resolved = r.contentType ? CONTENT_TYPE_MAP[r.contentType] : undefined;
  const customContentType = resolved ?? r.headers?.["content-type"] ?? r.headers?.["Content-Type"];
  const isJson = !r.binary && (!customContentType || customContentType === "application/json");
  return {
    statusCode: r.status,
    headers: {
      "Content-Type": customContentType ?? "application/json",
      ...r.headers,
      ...(resolved ? { "Content-Type": resolved } : {}),
    },
    body: r.binary ? String(r.body ?? "") : isJson ? JSON.stringify(r.body) : String(r.body ?? ""),
    ...(r.binary ? { isBase64Encoded: true } : {}),
  };
};

const notFound = () => ({
  statusCode: 404,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: "Not Found" }),
});

const unauthorized = () => ({
  statusCode: 401,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: "Unauthorized" }),
});

/** Check if a path matches any public pattern. Supports trailing `*` wildcard. */
const isPublicPath = (path: string, patterns: string[]): boolean =>
  patterns.some(p =>
    p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p,
  );

// ============ Wrapper ============

export const wrapApi = <T, C>(handler: ApiHandler<T, C>) => {
  const rt = createHandlerRuntime(handler, "api", handler.__spec.lambda?.logLevel ?? "info");
  const basePath = handler.__spec.basePath;
  const isStream = handler.__spec.stream === true;

  // Build GET route matchers at cold start
  const getMatchers = handler.get ? buildGetMatchers(handler.get, basePath) : [];

  const defaultError = (error: unknown, status: number) => {
    console.error(`[effortless:${rt.handlerName}]`, error);
    return toResult({
      status,
      body: {
        error: status === 400 ? "Validation failed" : "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
    });
  };

  // Core handler logic shared between buffered and streaming modes
  const handleRequest = async (event: LambdaEvent, streamCtx?: { rawStream: any; httpStream: any; stream: ResponseStream }) => {
    const startTime = Date.now();
    rt.patchConsole();
    let sharedArgs: Awaited<ReturnType<typeof rt.commonArgs>> | undefined;

    try {
      const req = {
        method: event.requestContext?.http?.method ?? event.httpMethod ?? "GET",
        path: event.requestContext?.http?.path ?? event.path ?? "/",
        headers: event.headers ?? {},
        query: event.queryStringParameters ?? {},
        params: event.pathParameters ?? {} as Record<string, string | undefined>,
        body: parseBody(event.body, event.isBase64Encoded ?? false),
        rawBody: event.body,
      };

      const input = { method: req.method, path: req.path, query: req.query, body: req.body };

      // Extract auth cookie from request headers
      const cookieHeader = req.headers["cookie"] ?? req.headers["Cookie"] ?? "";
      let authCookie: string | undefined;
      if (cookieHeader) {
        const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`));
        if (match) authCookie = match[1];
      }

      // Extract auth header (Authorization or custom header from apiToken config)
      const authHeaderName = handler.apiToken?.header ?? "authorization";
      const authHeader = req.headers[authHeaderName] ?? req.headers[authHeaderName.toLowerCase()] ?? undefined;

      // Resolve shared args (ctx, deps, config, files)
      sharedArgs = await rt.commonArgs(authCookie, authHeader);

      // Auth gate: reject unauthenticated requests to non-public paths
      if (handler.auth && sharedArgs.auth) {
        const auth = sharedArgs.auth as { session: unknown };
        const publicPaths = handler.auth.public ?? [];
        const routePath = req.path.replace(new RegExp(`^${basePath}`), "") || "/";
        if (!auth.session && !isPublicPath(routePath, publicPaths) && !isPublicPath(req.path, publicPaths)) {
          rt.logExecution(startTime, input, { status: 401 });
          return unauthorized();
        }
      }

      // GET / HEAD routing
      if (req.method === "GET" || req.method === "HEAD") {
        const matched = matchRoute(getMatchers, req.path);
        if (!matched) {
          rt.logExecution(startTime, input, { status: 404 });
          return notFound();
        }

        // Merge matched path params into req
        req.params = { ...req.params, ...matched.params };
        const args: Record<string, unknown> = { req, ...sharedArgs };
        if (streamCtx) args.stream = streamCtx.stream;

        try {
          const response = await (matched.handler as any)(args);
          if (response) {
            rt.logExecution(startTime, input, response.body);
            return toResult(response);
          }
          // void return — handler wrote to stream directly
          rt.logExecution(startTime, input, "[stream]");
          return undefined;
        } catch (error) {
          rt.logError(startTime, input, error);
          return handler.onError
            ? toResult(handler.onError({ error, req, ...sharedArgs }))
            : defaultError(error, 500);
        }
      }

      // POST handling
      if (req.method === "POST" && handler.post) {
        const args: Record<string, unknown> = { req, ...sharedArgs };
        if (streamCtx) args.stream = streamCtx.stream;

        if (handler.schema) {
          try {
            args.data = handler.schema(req.body);
          } catch (error) {
            rt.logError(startTime, input, error);
            return handler.onError
              ? toResult(handler.onError({ error, req, ...sharedArgs }))
              : defaultError(error, 400);
          }
        }

        try {
          const response = await (handler.post as any)(args);
          if (response) {
            rt.logExecution(startTime, input, response.body);
            return toResult(response);
          }
          // void return — handler wrote to stream directly
          rt.logExecution(startTime, input, "[stream]");
          return undefined;
        } catch (error) {
          rt.logError(startTime, input, error);
          return handler.onError
            ? toResult(handler.onError({ error, req, ...sharedArgs }))
            : defaultError(error, 500);
        }
      }

      // No matching route or method
      rt.logExecution(startTime, input, { status: 404 });
      return notFound();
    } finally {
      if (handler.onAfterInvoke && sharedArgs) {
        try { await handler.onAfterInvoke(sharedArgs); }
        catch (e) { console.error(`[effortless:${rt.handlerName}] onAfterInvoke error`, e); }
      }
      rt.restoreConsole();
    }
  };

  // Streaming mode: wrap with awslambda.streamifyResponse
  if (isStream) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamify = (globalThis as any).awslambda?.streamifyResponse;
    if (!streamify) {
      // Fallback for local dev / non-Lambda environments
      return async (event: LambdaEvent) => handleRequest(event);
    }

    return streamify(async (event: LambdaEvent, rawStream: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const HttpResponseStream = (globalThis as any).awslambda?.HttpResponseStream;

      // Check if handler uses SSE by running the route — we need to create the stream first
      // We start with a deferred approach: create stream helper, run handler, then decide
      let streamUsed = false;
      let sseMode = false;
      let httpStream: any = null;

      const ensureHttpStream = (contentType?: string) => {
        if (!httpStream) {
          httpStream = HttpResponseStream
            ? HttpResponseStream.from(rawStream, {
                statusCode: 200,
                headers: { "Content-Type": contentType ?? "text/plain; charset=utf-8" },
              })
            : rawStream;
        }
        return httpStream;
      };

      const stream: ResponseStream = {
        write: (chunk: string) => {
          streamUsed = true;
          const s = ensureHttpStream(sseMode ? "text/event-stream" : undefined);
          s.write(chunk);
        },
        end: () => {
          streamUsed = true;
          const s = ensureHttpStream();
          s.end();
        },
        sse: () => {
          sseMode = true;
          streamUsed = true;
          ensureHttpStream("text/event-stream");
        },
        event: (data: unknown) => {
          streamUsed = true;
          const s = ensureHttpStream("text/event-stream");
          sseMode = true;
          s.write(`data: ${JSON.stringify(data)}\n\n`);
        },
      };

      const result = await handleRequest(event, { rawStream, httpStream, stream });

      if (result && !streamUsed) {
        // Handler returned HttpResponse — write it to stream
        const hs = HttpResponseStream
          ? HttpResponseStream.from(rawStream, { statusCode: result.statusCode, headers: result.headers })
          : rawStream;
        hs.write(result.body);
        hs.end();
      } else if (!streamUsed) {
        // No result and no stream usage — shouldn't happen, but close stream
        rawStream.end();
      }
      // If streamUsed is true, the handler already wrote to and closed the stream
    });
  }

  // Buffered mode (default)
  return async (event: LambdaEvent) => {
    const result = await handleRequest(event);
    return result ?? notFound();
  };
};
