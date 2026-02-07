import type { HttpHandler } from "~/handlers/define-http";

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

export const wrapHttp = <C>(handler: HttpHandler<C>) => {
  let deps: C | null = null;
  const getDeps = () => (deps ??= handler.context?.() as C);

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = handler.context
      ? await (handler.onRequest as any)({ req, ctx: getDeps() })
      : await (handler.onRequest as any)({ req });

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json", ...response.headers },
      body: JSON.stringify(response.body),
    };
  };
};
