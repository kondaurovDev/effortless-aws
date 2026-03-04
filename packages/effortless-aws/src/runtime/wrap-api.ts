import type { ApiHandler } from "../handlers/define-api";
import type { ContentType } from "../handlers/shared";
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
    const fullPattern = basePath + pattern;
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

const toResult = (r: { status: number; body?: unknown; contentType?: ContentType; headers?: Record<string, string> }) => {
  const resolved = r.contentType ? CONTENT_TYPE_MAP[r.contentType] : undefined;
  const customContentType = resolved ?? r.headers?.["content-type"] ?? r.headers?.["Content-Type"];
  const isJson = !customContentType || customContentType === "application/json";
  return {
    statusCode: r.status,
    headers: {
      "Content-Type": customContentType ?? "application/json",
      ...r.headers,
      ...(resolved ? { "Content-Type": resolved } : {}),
    },
    body: isJson ? JSON.stringify(r.body) : String(r.body ?? ""),
  };
};

const notFound = () => ({
  statusCode: 404,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error: "Not Found" }),
});

// ============ Wrapper ============

export const wrapApi = <T, C>(handler: ApiHandler<T, C>) => {
  const rt = createHandlerRuntime(handler, "api", handler.__spec.logLevel ?? "info");
  const basePath = handler.__spec.basePath;

  // Build GET route matchers at cold start
  const getMatchers = handler.get ? buildGetMatchers(handler.get, basePath) : [];

  const defaultError = (error: unknown, status: number) => {
    console.error(`[effortless:${rt.handlerName}]`, error);
    return {
      statusCode: status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: status === 400 ? "Validation failed" : "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  };

  return async (event: LambdaEvent) => {
    const startTime = Date.now();
    rt.patchConsole();

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

      // Resolve shared args (ctx, deps, config, files)
      const sharedArgs = await rt.commonArgs();

      // GET / HEAD routing
      if (req.method === "GET" || req.method === "HEAD") {
        const matched = matchRoute(getMatchers, req.path);
        if (!matched) {
          rt.logExecution(startTime, input, { status: 404 });
          return notFound();
        }

        // Merge matched path params into req
        req.params = { ...req.params, ...matched.params };
        const args = { req, ...sharedArgs };

        try {
          const response = await (matched.handler as any)(args);
          rt.logExecution(startTime, input, response.body);
          return toResult(response);
        } catch (error) {
          rt.logError(startTime, input, error);
          return handler.onError
            ? toResult(handler.onError(error, req))
            : defaultError(error, 500);
        }
      }

      // POST handling
      if (req.method === "POST" && handler.post) {
        const args: Record<string, unknown> = { req, ...sharedArgs };

        if (handler.schema) {
          try {
            args.data = handler.schema(req.body);
          } catch (error) {
            rt.logError(startTime, input, error);
            return handler.onError
              ? toResult(handler.onError(error, req))
              : defaultError(error, 400);
          }
        }

        try {
          const response = await (handler.post as any)(args);
          rt.logExecution(startTime, input, response.body);
          return toResult(response);
        } catch (error) {
          rt.logError(startTime, input, error);
          return handler.onError
            ? toResult(handler.onError(error, req))
            : defaultError(error, 500);
        }
      }

      // No matching route or method
      rt.logExecution(startTime, input, { status: 404 });
      return notFound();
    } finally {
      rt.restoreConsole();
    }
  };
};
