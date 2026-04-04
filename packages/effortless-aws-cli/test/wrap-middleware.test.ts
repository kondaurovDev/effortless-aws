import { describe, it, expect } from "vitest"
import { wrapMiddleware, wrapMiddlewareFn } from "~aws/runtime/wrap-middleware"
import type { StaticSiteHandler, MiddlewareRequest, MiddlewareResult } from "~aws/handlers/define-static-site"
import { generateMiddlewareEntryPoint } from "~cli/build/handler-registry"

const makeHandler = (
  middleware: (req: MiddlewareRequest) => Promise<MiddlewareResult> | MiddlewareResult
): StaticSiteHandler =>
  ({
    __brand: "effortless-static-site",
    __spec: { dir: "dist" },
    routes: [],
    middleware,
  }) as StaticSiteHandler;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeCfEvent = (overrides: {
  uri?: string;
  method?: string;
  querystring?: string;
  headers?: Record<string, { key?: string; value: string }[]>;
} = {}): any => ({
  Records: [{
    cf: {
      request: {
        clientIp: "1.2.3.4",
        method: overrides.method ?? "GET",
        uri: overrides.uri ?? "/dashboard",
        querystring: overrides.querystring ?? "",
        headers: overrides.headers ?? {},
      },
    },
  }],
});

describe("wrapMiddleware", () => {

  it("should pass-through and apply URL rewrite when middleware returns void", async () => {
    const handler = wrapMiddleware(makeHandler(() => undefined));
    const event = makeCfEvent({ uri: "/about/" });
    const result = await handler(event);

    // Should return the modified CF request with rewritten URI
    expect(result).toHaveProperty("uri", "/about/index.html");
    expect(result).toHaveProperty("method", "GET");
  });

  it("should rewrite bare path to /path/index.html", async () => {
    const handler = wrapMiddleware(makeHandler(() => undefined));
    const event = makeCfEvent({ uri: "/docs/getting-started" });
    const result = await handler(event);

    expect(result).toHaveProperty("uri", "/docs/getting-started/index.html");
  });

  it("should not rewrite paths with file extensions", async () => {
    const handler = wrapMiddleware(makeHandler(() => undefined));
    const event = makeCfEvent({ uri: "/assets/style.css" });
    const result = await handler(event);

    expect(result).toHaveProperty("uri", "/assets/style.css");
  });

  it("should return redirect response with default 302", async () => {
    const handler = wrapMiddleware(
      makeHandler(() => ({ redirect: "https://example.com/login" }))
    );
    const result = await handler(makeCfEvent());

    expect(result).toEqual({
      status: "302",
      statusDescription: "Found",
      headers: {
        location: [{ key: "Location", value: "https://example.com/login" }],
      },
    });
  });

  it("should return redirect response with custom 301 status", async () => {
    const handler = wrapMiddleware(
      makeHandler(() => ({ redirect: "/new-page", status: 301 as const }))
    );
    const result = await handler(makeCfEvent());

    expect(result).toEqual({
      status: "301",
      statusDescription: "Moved Permanently",
      headers: {
        location: [{ key: "Location", value: "/new-page" }],
      },
    });
  });

  it("should return 403 deny response", async () => {
    const handler = wrapMiddleware(
      makeHandler(() => ({ status: 403 as const }))
    );
    const result = await handler(makeCfEvent());

    expect(result).toEqual({
      status: "403",
      statusDescription: "Forbidden",
      body: "Forbidden",
    });
  });

  it("should return 403 deny with custom body", async () => {
    const handler = wrapMiddleware(
      makeHandler(() => ({ status: 403 as const, body: "Access Denied" }))
    );
    const result = await handler(makeCfEvent());

    expect(result).toEqual({
      status: "403",
      statusDescription: "Forbidden",
      body: "Access Denied",
    });
  });

  it("should return 500 when middleware throws", async () => {
    const handler = wrapMiddleware(
      makeHandler(() => { throw new Error("Boom"); })
    );
    const result = await handler(makeCfEvent());

    expect(result).toEqual({
      status: "500",
      statusDescription: "Internal Server Error",
      body: "Internal Server Error",
    });
  });

  it("should parse headers into flat object", async () => {
    let receivedRequest: MiddlewareRequest | undefined;
    const handler = wrapMiddleware(
      makeHandler((req) => { receivedRequest = req; })
    );

    await handler(makeCfEvent({
      headers: {
        host: [{ key: "Host", value: "example.com" }],
        accept: [{ key: "Accept", value: "text/html" }],
      },
    }));

    expect(receivedRequest!.headers).toEqual({
      host: "example.com",
      accept: "text/html",
    });
  });

  it("should parse cookies from Cookie header", async () => {
    let receivedRequest: MiddlewareRequest | undefined;
    const handler = wrapMiddleware(
      makeHandler((req) => { receivedRequest = req; })
    );

    await handler(makeCfEvent({
      headers: {
        cookie: [{ key: "Cookie", value: "session=abc123; theme=dark" }],
      },
    }));

    expect(receivedRequest!.cookies).toEqual({
      session: "abc123",
      theme: "dark",
    });
  });

  it("should return empty cookies when no cookie header", async () => {
    let receivedRequest: MiddlewareRequest | undefined;
    const handler = wrapMiddleware(
      makeHandler((req) => { receivedRequest = req; })
    );

    await handler(makeCfEvent());

    expect(receivedRequest!.cookies).toEqual({});
  });

  it("should pass uri, method, and querystring to middleware", async () => {
    let receivedRequest: MiddlewareRequest | undefined;
    const handler = wrapMiddleware(
      makeHandler((req) => { receivedRequest = req; })
    );

    await handler(makeCfEvent({
      uri: "/admin/users",
      method: "POST",
      querystring: "page=1&limit=10",
    }));

    expect(receivedRequest!.uri).toBe("/admin/users");
    expect(receivedRequest!.method).toBe("POST");
    expect(receivedRequest!.querystring).toBe("page=1&limit=10");
  });

  it("should handle async middleware", async () => {
    const handler = wrapMiddleware(
      makeHandler(async (req) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (!req.cookies.token) {
          return { redirect: "/login" };
        }
      })
    );

    // Without token → redirect
    const result1 = await handler(makeCfEvent());
    expect(result1).toHaveProperty("status", "302");

    // With token → pass-through
    const result2 = await handler(makeCfEvent({
      uri: "/dashboard/",
      headers: {
        cookie: [{ key: "Cookie", value: "token=valid" }],
      },
    }));
    expect(result2).toHaveProperty("uri", "/dashboard/index.html");
  });

});

describe("wrapMiddlewareFn", () => {

  it("should work with a standalone middleware function", async () => {
    const handler = wrapMiddlewareFn((req) => {
      if (!req.cookies.session) return { redirect: "/login" };
    });
    const result = await handler(makeCfEvent());
    expect(result).toHaveProperty("status", "302");
  });

  it("should pass-through and rewrite URL when middleware returns void", async () => {
    const handler = wrapMiddlewareFn(() => undefined);
    const event = makeCfEvent({ uri: "/about/" });
    const result = await handler(event);
    expect(result).toHaveProperty("uri", "/about/index.html");
  });

});

describe("generateMiddlewareEntryPoint", () => {

  it("should extract middleware from named export", () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      import { Auth } from "../core";
      export const webapp = defineStaticSite({ dir: "dist" })
        .middleware((request) => {
          if (request.cookies[Auth.COOKIE] === Auth.TOKEN) return;
          return { redirect: "/login" };
        })
        .build();
    `;
    const { entryPoint, exportName } = generateMiddlewareEntryPoint(source, "/fake/runtime");
    expect(exportName).toBe("webapp");
    expect(entryPoint).toContain('import { Auth } from "../core"');
    expect(entryPoint).toContain("wrapMiddlewareFn");
    expect(entryPoint).toContain("Auth.COOKIE");
    expect(entryPoint).toContain("Auth.TOKEN");
    // Should NOT contain unused imports or handler config
    expect(entryPoint).not.toContain("defineStaticSite");
    expect(entryPoint).not.toContain('dir: "dist"');
  });

  it("should extract middleware from default export", () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      export default defineStaticSite({ dir: "dist" })
        .middleware((req) => {
          if (req.uri === "/health") return;
          return { redirect: "/login" };
        })
        .build();
    `;
    const { entryPoint, exportName } = generateMiddlewareEntryPoint(source, "/fake/runtime");
    expect(exportName).toBe("default");
    expect(entryPoint).toContain("wrapMiddlewareFn");
    expect(entryPoint).toContain('req.uri === "/health"');
  });

  it("should only include imports referenced by middleware", () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      import { Auth } from "../core/auth";
      import { Config } from "../config";
      import { HttpClient } from "../core/services";
      export const site = defineStaticSite({ dir: "dist" })
        .middleware((req) => {
          if (req.cookies[Auth.NAME] === Config.TOKEN) return;
          return { redirect: "/login" };
        })
        .build();
    `;
    const { entryPoint } = generateMiddlewareEntryPoint(source, "/fake/runtime");
    expect(entryPoint).toContain('import { Auth } from "../core/auth"');
    expect(entryPoint).toContain('import { Config } from "../config"');
    // Unused imports should be excluded
    expect(entryPoint).not.toContain("defineStaticSite");
    expect(entryPoint).not.toContain("HttpClient");
  });

  it("should throw when no middleware found", () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      export const site = defineStaticSite({ dir: "dist" })
        .build();
    `;
    expect(() => generateMiddlewareEntryPoint(source, "/fake/runtime")).toThrow(
      "Could not extract middleware function"
    );
  });

});
