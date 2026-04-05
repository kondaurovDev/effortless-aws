import type { StaticSiteHandler, MiddlewareRequest, MiddlewareRedirect, MiddlewareResult } from "../handlers/define-static-site";

type CfHeader = { key?: string; value: string };
type CfHeaders = Record<string, CfHeader[]>;

type CfRequest = {
  clientIp: string;
  method: string;
  uri: string;
  querystring: string;
  headers: CfHeaders;
};

type CfEvent = {
  Records: [{ cf: { request: CfRequest } }];
};

const parseHeaders = (cfHeaders: CfHeaders): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(cfHeaders)) {
    if (values.length > 0) {
      result[key] = values[0]!.value;
    }
  }
  return result;
};

const parseCookies = (cfHeaders: CfHeaders): Record<string, string> => {
  const cookies: Record<string, string> = {};
  const cookieHeaders = cfHeaders.cookie;
  if (!cookieHeaders) return cookies;
  for (const { value } of cookieHeaders) {
    for (const pair of value.split(";")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (name) cookies[name] = val;
    }
  }
  return cookies;
};

const rewriteUrl = (uri: string): string => {
  if (uri.endsWith("/")) return uri + "index.html";
  if (!uri.includes(".")) return uri + "/index.html";
  return uri;
};

const isRedirect = (result: MiddlewareResult): result is MiddlewareRedirect =>
  result != null && "redirect" in result;

const isDeny = (result: MiddlewareResult): result is { status: 403; body?: string } =>
  result != null && "status" in result && result.status === 403;

export const wrapMiddlewareFn = (
  middleware: (request: MiddlewareRequest) => Promise<MiddlewareResult> | MiddlewareResult
) => {
  return async (event: CfEvent) => {
    const cfRequest = event.Records[0].cf.request;

    const request: MiddlewareRequest = {
      uri: cfRequest.uri,
      method: cfRequest.method,
      querystring: cfRequest.querystring,
      headers: parseHeaders(cfRequest.headers),
      cookies: parseCookies(cfRequest.headers),
    };

    try {
      const result = await middleware(request);

      if (isRedirect(result)) {
        const statusCode = result.status ?? 302;
        const descriptions: Record<number, string> = {
          301: "Moved Permanently",
          302: "Found",
          307: "Temporary Redirect",
          308: "Permanent Redirect",
        };
        return {
          status: String(statusCode),
          statusDescription: descriptions[statusCode] ?? "Found",
          headers: {
            location: [{ key: "Location", value: result.redirect }],
          },
        };
      }

      if (isDeny(result)) {
        return {
          status: "403",
          statusDescription: "Forbidden",
          body: result.body ?? "Forbidden",
        };
      }

      // Continue serving — apply URL rewrite
      cfRequest.uri = rewriteUrl(cfRequest.uri);
      return cfRequest;
    } catch (error) {
      console.error("Middleware error:", error);
      return {
        status: "500",
        statusDescription: "Internal Server Error",
        body: "Internal Server Error",
      };
    }
  };
};

export const wrapMiddleware = (handler: StaticSiteHandler) => {
  const middleware = (handler as any).middleware as (
    request: MiddlewareRequest
  ) => Promise<MiddlewareResult> | MiddlewareResult;
  return wrapMiddlewareFn(middleware);
};
