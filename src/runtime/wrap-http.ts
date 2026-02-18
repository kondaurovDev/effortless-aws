import type { HttpHandler, ContentType } from "~/handlers/define-http";
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

export const wrapHttp = <T, C>(handler: HttpHandler<T, C>) => {
  const rt = createHandlerRuntime(handler, "http", handler.__spec.logLevel ?? "info");

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
        params: event.pathParameters ?? {},
        body: parseBody(event.body, event.isBase64Encoded ?? false),
        rawBody: event.body,
      };

      const input = { method: req.method, path: req.path, query: req.query, body: req.body };

      const args: Record<string, unknown> = { req };
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

      // Resolve shared args
      Object.assign(args, await rt.commonArgs());

      try {
        const response = await (handler.onRequest as any)(args);
        rt.logExecution(startTime, input, response.body);
        return toResult(response);
      } catch (error) {
        rt.logError(startTime, input, error);
        return handler.onError
          ? toResult(handler.onError(error, req))
          : defaultError(error, 500);
      }
    } finally {
      rt.restoreConsole();
    }
  };
};
