import type { ApiHandler, RouteEntry, OkHelper, FailHelper } from "../handlers/define-api";
import type { ContentType, HttpResponse, ResponseStream } from "../handlers/shared";
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

// ============ Response helpers ============

const toResult = (r: { status: number; body?: unknown; contentType?: ContentType; headers?: Record<string, string>; cookies?: string[]; binary?: boolean }) => {
  const resolved = r.contentType ? CONTENT_TYPE_MAP[r.contentType] : undefined;
  const customContentType = resolved ?? r.headers?.["content-type"] ?? r.headers?.["Content-Type"];
  const isJson = !r.binary && (!customContentType || customContentType === "application/json");

  // Collect cookies: explicit cookies array takes precedence, fall back to set-cookie header
  const cookies = r.cookies?.length
    ? r.cookies
    : r.headers?.["set-cookie"]
      ? [r.headers["set-cookie"]]
      : undefined;

  // Remove set-cookie from headers when using cookies array (Lambda Function URL handles it separately)
  const { "set-cookie": _sc, ...headersWithoutSetCookie } = r.headers ?? {};

  return {
    statusCode: r.status,
    headers: {
      "Content-Type": customContentType ?? "application/json",
      ...headersWithoutSetCookie,
      ...(resolved ? { "Content-Type": resolved } : {}),
    },
    ...(cookies ? { cookies } : {}),
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

// ============ Cache helpers ============

const buildCacheControl = (cache: { private?: boolean; ttl: number; swr?: number }): string =>
  cache.private
    ? `private, max-age=${cache.ttl}`
    : `public, max-age=${cache.ttl}, s-maxage=${cache.ttl}, stale-while-revalidate=${cache.swr}`;

// ============ Route matching ============

/** Extract param names from a route pattern like /templates/{id} */
const extractParamNames = (pattern: string): string[] => {
  const names: string[] = [];
  pattern.replace(/\{(\w+)\}/g, (_, name) => { names.push(name); return ""; });
  return names;
};

/** Convert a route pattern like /templates/{id} to a RegExp */
const patternToRegex = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "{" || ch === "}" ? ch : `\\${ch}`
  );
  const withParams = escaped.replace(/\{(\w+)\}/g, "([^/]+)");
  return new RegExp(`^${withParams}$`);
};

type RouteMatch = { entry: RouteEntry; params: Record<string, string> };

/** Find a matching route for the given method and path (relative to basePath) */
const findRoute = (routes: RouteEntry[], method: string, relativePath: string): RouteMatch | undefined => {
  for (const r of routes) {
    if (!(r.method === method || (r.method === "GET" && method === "HEAD"))) continue;
    if (r.path === relativePath) return { entry: r, params: {} };
    const regex = patternToRegex(r.path);
    const match = relativePath.match(regex);
    if (match) {
      const names = extractParamNames(r.path);
      const params: Record<string, string> = {};
      for (let i = 0; i < names.length; i++) params[names[i]!] = decodeURIComponent(match[i + 1]!);
      return { entry: r, params };
    }
  }
  return undefined;
};

// ============ Wrapper ============

export const wrapApi = <C>(handler: ApiHandler<C>) => {
  const rt = createHandlerRuntime(handler, "api", handler.__spec.lambda?.logLevel ?? "info", () => ({ ok, fail }));
  const basePath = handler.__spec.basePath;
  const isStream = handler.__spec.stream === true;
  const routes = handler.routes ?? [];

  // Response helpers injected into route args and setup
  const ok: OkHelper = (body?: unknown, status: number = 200): HttpResponse => ({ status, body });
  const fail: FailHelper = (message: string, status: number = 400): HttpResponse => ({ status, body: { error: message } });

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

  /** Extract relative path after basePath: /basePath/foo/bar → /foo/bar */
  const extractRelativePath = (fullPath: string): string | null => {
    const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
    if (!fullPath.startsWith(prefix)) return null;
    const rest = fullPath.slice(prefix.length);
    if (rest === "" || rest === "/") return "/";
    if (!rest.startsWith("/")) return null;
    return rest;
  };

  // Core handler logic shared between buffered and streaming modes
  const handleRequest = async (event: LambdaEvent, streamCtx?: { rawStream: any; httpStream: any; stream: ResponseStream }) => {
    const startTime = Date.now();
    rt.patchConsole();
    let sharedArgs: Awaited<ReturnType<typeof rt.commonArgs>> | undefined;
    let ctxProps: Record<string, unknown> = {};

    try {
      const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
      const path = event.requestContext?.http?.path ?? event.path ?? "/";
      const headers = event.headers ?? {};
      const body = parseBody(event.body, event.isBase64Encoded ?? false);

      const logInput = { method, path, query: event.queryStringParameters ?? {}, body };
      const relativePath = extractRelativePath(path);

      if (!relativePath) {
        rt.logExecution(startTime, logInput, { status: 404 });
        return notFound();
      }

      const routeMatch = findRoute(routes, method, relativePath);
      if (!routeMatch) {
        rt.logExecution(startTime, logInput, { status: 404 });
        return notFound();
      }

      const { entry, params: routeParams } = routeMatch;
      const query = event.queryStringParameters ?? {};
      const params = { ...(event.pathParameters ?? {}), ...routeParams };

      // Merged input: query < body < params (higher priority wins)
      const merged = {
        ...query,
        ...(typeof body === "object" && body !== null ? body as Record<string, unknown> : {}),
        ...params,
      };

      const req = {
        method, path, headers, query, params, body,
        rawBody: event.body,
      };

      // Extract auth cookie from request headers
      const cookieHeader = req.headers["cookie"] ?? req.headers["Cookie"] ?? "";
      let authCookie: string | undefined;
      if (cookieHeader) {
        const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE_NAME}=([^;]+)`));
        if (match) authCookie = match[1];
      }
      // Auth header name is resolved lazily after auth callback runs in commonArgs
      const authHeaderName = "authorization";
      const authHeader = req.headers[authHeaderName] ?? req.headers[authHeaderName.toLowerCase()] ?? undefined;
      sharedArgs = await rt.commonArgs(authCookie, authHeader, req.headers as Record<string, string | undefined>);

      // Auth gate
      if (sharedArgs.auth) {
        const auth = sharedArgs.auth as { session: unknown };
        if (!auth.session && !entry.public) {
          rt.logExecution(startTime, logInput, { status: 401 });
          return unauthorized();
        }
      }

      // Validate input if route has a schema
      let validatedInput: unknown = merged;
      if (entry.schema && typeof entry.schema === "object" && "~standard" in entry.schema) {
        const schema = entry.schema as { "~standard": { validate?: (value: unknown) => any } };
        if (typeof schema["~standard"].validate === "function") {
          const result = await schema["~standard"].validate(merged);
          if (result.issues) {
            const issues = (result.issues as { message: string; path?: any[] }[]).map(i => {
              const path = i.path?.map((p: any) => typeof p === "object" ? p.key : p).join(".");
              return path ? `${path}: ${i.message}` : i.message;
            });
            rt.logExecution(startTime, logInput, { status: 400 });
            return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Validation failed", issues }) };
          }
          validatedInput = result.value;
        }
      }

      // Spread ctx into route args (strip auth config, replaced by AuthHelpers)
      const { ctx, auth, ...rest } = sharedArgs;
      ctxProps = ctx && typeof ctx === "object" ? { ...ctx as Record<string, unknown> } : {};
      delete ctxProps.auth;
      const args: Record<string, unknown> = { ...ctxProps, req, input: validatedInput, ok, fail, ...rest };
      if (auth) args.auth = auth;
      if (streamCtx) args.stream = streamCtx.stream;

      try {
        const response = await entry.onRequest(args);
        if (response) {
          // Inject Cache-Control header if route has cache option and handler didn't set it manually
          if (entry.cache != null && !response.headers?.["Cache-Control"] && !response.headers?.["cache-control"]) {
            response.headers = { ...response.headers, "Cache-Control": buildCacheControl(entry.cache) };
          }
          rt.logExecution(startTime, logInput, response.body);
          return toResult(response);
        }
        rt.logExecution(startTime, logInput, "[stream]");
        return undefined;
      } catch (error) {
        rt.logError(startTime, logInput, error);
        return handler.onError
          ? toResult(await handler.onError({ error, req, ok, fail, ...ctxProps }))
          : defaultError(error, 500);
      }
    } finally {
      if (handler.onCleanup && sharedArgs) {
        try { await handler.onCleanup(ctxProps); }
        catch (e) { console.error(`[effortless:${rt.handlerName}] onCleanup error`, e); }
      }
      rt.restoreConsole();
    }
  };

  // Streaming mode: wrap with awslambda.streamifyResponse
  if (isStream) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamify = (globalThis as any).awslambda?.streamifyResponse;
    if (!streamify) {
      return async (event: LambdaEvent) => handleRequest(event);
    }

    return streamify(async (event: LambdaEvent, rawStream: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const HttpResponseStream = (globalThis as any).awslambda?.HttpResponseStream;

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
        const hs = HttpResponseStream
          ? HttpResponseStream.from(rawStream, { statusCode: result.statusCode, headers: result.headers })
          : rawStream;
        hs.write(result.body);
        hs.end();
      } else if (!streamUsed) {
        rawStream.end();
      }
    });
  }

  // Buffered mode (default)
  return async (event: LambdaEvent) => {
    const result = await handleRequest(event);
    return result ?? notFound();
  };
};
