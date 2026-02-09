import type { HttpHandler } from "~/handlers/define-http";
import { buildDeps, buildParams } from "./handler-utils";

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
  let ctx: C | null = null;
  let resolvedDeps: Record<string, unknown> | undefined;
  let resolvedParams: Record<string, unknown> | undefined | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDeps = () => (resolvedDeps ??= buildDeps((handler as any).deps));

  const getParams = async () => {
    if (resolvedParams !== null) return resolvedParams;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolvedParams = await buildParams((handler as any).params);
    return resolvedParams;
  };

  const getCtx = async () => {
    if (ctx !== null) return ctx;
    if (handler.context) {
      const params = await getParams();
      ctx = params
        ? await handler.context({ params })
        : await handler.context();
    }
    return ctx;
  };

  return async (event: LambdaEvent) => {
    const req = {
      method: event.requestContext?.http?.method ?? event.httpMethod ?? "GET",
      path: event.requestContext?.http?.path ?? event.path ?? "/",
      headers: event.headers ?? {},
      query: event.queryStringParameters ?? {},
      params: event.pathParameters ?? {},
      body: parseBody(event.body, event.isBase64Encoded ?? false),
      rawBody: event.body,
    };

    const toResult = (r: { status: number; body?: unknown; headers?: Record<string, string> }) => ({
      statusCode: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
      body: JSON.stringify(r.body),
    });

    const defaultError = (error: unknown, status: number) => ({
      statusCode: status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: status === 400 ? "Validation failed" : "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: Record<string, unknown> = { req };

    if (handler.schema) {
      try {
        args.data = handler.schema(req.body);
      } catch (error) {
        return handler.onError
          ? toResult(handler.onError(error, req))
          : defaultError(error, 400);
      }
    }

    if (handler.context) {
      args.ctx = await getCtx();
    }

    const deps = getDeps();
    if (deps) {
      args.deps = deps;
    }

    const params = await getParams();
    if (params) {
      args.params = params;
    }

    try {
      const response = await (handler.onRequest as any)(args);
      return toResult(response);
    } catch (error) {
      return handler.onError
        ? toResult(handler.onError(error, req))
        : defaultError(error, 500);
    }
  };
};
