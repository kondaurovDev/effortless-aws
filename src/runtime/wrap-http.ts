import type { HttpHandler } from "~/handlers/define-http";
import { createHandlerRuntime } from "./handler-utils";
import { truncateForStorage } from "./platform-types";

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
  const rt = createHandlerRuntime(handler, "http");

  const toResult = (r: { status: number; body?: unknown; headers?: Record<string, string> }) => ({
    statusCode: r.status,
    headers: { "Content-Type": "application/json", ...r.headers },
    body: JSON.stringify(r.body),
  });

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

    const req = {
      method: event.requestContext?.http?.method ?? event.httpMethod ?? "GET",
      path: event.requestContext?.http?.path ?? event.path ?? "/",
      headers: event.headers ?? {},
      query: event.queryStringParameters ?? {},
      params: event.pathParameters ?? {},
      body: parseBody(event.body, event.isBase64Encoded ?? false),
      rawBody: event.body,
    };

    const input = truncateForStorage({ method: req.method, path: req.path, query: req.query, body: req.body });

    // Schema validation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  };
};
