import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

// Mock internal modules — no AWS SDK mocks needed
const mockGetParameters = vi.fn().mockResolvedValue(new Map());
vi.mock("~aws/runtime/ssm-client", () => ({
  getParameters: (...args: unknown[]) => mockGetParameters(...args),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {
    putItem = vi.fn();
    getItem = vi.fn();
    deleteItem = vi.fn();
    query = vi.fn();
  },
}));

import { wrapApi } from "~aws/runtime/wrap-api"
import type { ApiHandler } from "~aws/handlers/define-api"

const makeHandler = (overrides: Partial<ApiHandler> = {}): ApiHandler => ({
  __brand: "effortless-api",
  __spec: { basePath: "/api", ...overrides.__spec },
  ...overrides,
} as ApiHandler);

const makeEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "GET", path: "/api/hello" } },
  headers: {},
  queryStringParameters: {},
  pathParameters: {},
  body: undefined as string | undefined,
  isBase64Encoded: false,
  ...overrides,
});

describe("wrapApi", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============ Routing ============

  describe("routing", () => {
    it("returns 404 for unknown route", async () => {
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "hi" }) }] }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/unknown" } } }));
      expect(result.statusCode).toBe(404);
    });

    it("returns 404 when path does not match basePath", async () => {
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "hi" }) }] }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/other/hello" } } }));
      expect(result.statusCode).toBe(404);
    });

    it("routes GET to matching route", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: { ok: true } });
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: handler }] }));
      const result = await fn(makeEvent());
      expect(result.statusCode).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("routes HEAD to GET route", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: handler }] }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "HEAD", path: "/api/hello" } } }));
      expect(result.statusCode).toBe(200);
    });

    it("routes POST to matching route", async () => {
      const handler = vi.fn().mockReturnValue({ status: 201, body: { id: "1" } });
      const fn = wrapApi(makeHandler({
        routes: [{ method: "POST", path: "/create", onRequest: handler }],
      }));
      const result = await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        body: JSON.stringify({ name: "test" }),
      }));
      expect(result.statusCode).toBe(201);
    });

    it("returns 404 for method mismatch", async () => {
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "hi" }) }] }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "PUT", path: "/api/hello" } } }));
      expect(result.statusCode).toBe(404);
    });
  });

  // ============ Body parsing ============

  describe("body parsing", () => {
    it("parses JSON body and makes it available on req", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeHandler({
        routes: [{ method: "POST", path: "/create", onRequest: handler }],
      }));
      await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        body: JSON.stringify({ name: "test" }),
      }));
      expect(handler.mock.calls[0]![0]!.req.body).toEqual({ name: "test" });
    });

    it("decodes base64 body", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeHandler({
        routes: [{ method: "POST", path: "/create", onRequest: handler }],
      }));
      await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        body: Buffer.from(JSON.stringify({ encoded: true })).toString("base64"),
        isBase64Encoded: true,
      }));
      expect(handler.mock.calls[0]![0]!.req.body).toEqual({ encoded: true });
    });

    it("returns raw string when body is not JSON", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeHandler({
        routes: [{ method: "POST", path: "/create", onRequest: handler }],
      }));
      await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        body: "plain text",
      }));
      expect(handler.mock.calls[0]![0]!.req.body).toBe("plain text");
    });
  });

  // ============ Content types ============

  describe("response content types", () => {
    it("defaults to application/json", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: { msg: "hi" } }) }],
      }));
      const result = await fn(makeEvent());
      expect(result.headers["Content-Type"]).toBe("application/json");
      expect(result.body).toBe(JSON.stringify({ msg: "hi" }));
    });

    it("uses html content type", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/page", onRequest: () => ({ status: 200, body: "<h1>Hi</h1>", contentType: "html" as any }) }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/page" } } }));
      expect(result.headers["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(result.body).toBe("<h1>Hi</h1>");
    });

    it("uses csv content type", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/data", onRequest: () => ({ status: 200, body: "a,b\n1,2", contentType: "csv" as any }) }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/data" } } }));
      expect(result.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    });

    it("returns binary response with isBase64Encoded", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/img", onRequest: () => ({ status: 200, body: "base64data", binary: true }) }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/img" } } }));
      expect(result.isBase64Encoded).toBe(true);
      expect(result.body).toBe("base64data");
    });

    it("uses custom content-type header", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/custom", onRequest: () => ({
          status: 200,
          body: "data",
          headers: { "content-type": "application/octet-stream" },
        }) }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/custom" } } }));
      expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    });
  });

  // ============ Auth gate ============

  describe("auth gate", () => {
    const makeAuthHandler = (overrides: Partial<ApiHandler> = {}): ApiHandler =>
      makeHandler({
        setup: (() => ({ auth: { secret: "test-secret-key-32-chars-long!!", expiresIn: "7d" } })) as any,
        ...overrides,
      });

    it("returns 401 for route when auth enabled and no session", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeAuthHandler({
        routes: [{ method: "GET", path: "/secret", onRequest: handler, public: false }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/secret" } } }));
      expect(result.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows public route without session", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "public data" });
      const fn = wrapApi(makeAuthHandler({
        routes: [{ method: "GET", path: "/open", onRequest: handler, public: true }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/open" } } }));
      expect(result.statusCode).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("returns 401 for POST route when auth enabled and no session", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeAuthHandler({
        routes: [{ method: "POST", path: "/secret", onRequest: handler }],
      }));
      const result = await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/secret" } },
        body: "{}",
      }));
      expect(result.statusCode).toBe(401);
    });

    it("allows public POST route without session", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeAuthHandler({
        routes: [{ method: "POST", path: "/register", onRequest: handler, public: true }],
      }));
      const result = await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/register" } },
        body: "{}",
      }));
      expect(result.statusCode).toBe(200);
    });
  });

  // ============ Error handling ============

  describe("error handling", () => {
    it("returns 500 on handler error", async () => {
      const fn = wrapApi(makeHandler({
        routes: [{ method: "GET", path: "/fail", onRequest: () => { throw new Error("boom"); } }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/fail" } } }));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe("Internal server error");
    });

    it("uses custom onError handler", async () => {
      const fn = wrapApi(makeHandler({
        onError: ({ error }) => ({
          status: 422,
          body: { custom: true, msg: (error as Error).message },
        }),
        routes: [{ method: "GET", path: "/fail", onRequest: () => { throw new Error("oops"); } }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/fail" } } }));
      expect(result.statusCode).toBe(422);
      expect(JSON.parse(result.body).custom).toBe(true);
    });

    it("returns custom error with onError on handler error", async () => {
      const fn = wrapApi(makeHandler({
        onError: () => ({ status: 400, body: { custom: "error" } }),
        routes: [{ method: "GET", path: "/search", onRequest: () => {
          throw new Error("bad input");
        } }],
      }));
      const result = await fn(makeEvent({ requestContext: { http: { method: "GET", path: "/api/search" } } }));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).custom).toBe("error");
    });
  });

  // ============ req.validate with merged input ============

  describe("merged input", () => {
    it("merges query params into input", async () => {
      const handler = vi.fn(({ input }: any) => ({ status: 200, body: input }));
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: handler }] }));
      const result = await fn(makeEvent({ queryStringParameters: { q: "test" } }));
      expect(JSON.parse(result.body).q).toBe("test");
    });

    it("merges body into input", async () => {
      const handler = vi.fn(({ input }: any) => ({ status: 200, body: input }));
      const fn = wrapApi(makeHandler({ routes: [{ method: "POST", path: "/create", onRequest: handler }] }));
      const result = await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        body: JSON.stringify({ name: "test" }),
      }));
      expect(JSON.parse(result.body).name).toBe("test");
    });

    it("merges path params with highest priority", async () => {
      const handler = vi.fn(({ input }: any) => ({ status: 200, body: input }));
      const fn = wrapApi(makeHandler({ routes: [{ method: "GET", path: "/hello", onRequest: handler }] }));
      const result = await fn(makeEvent({
        queryStringParameters: { id: "from-query" },
        pathParameters: { id: "from-path" },
      }));
      expect(JSON.parse(result.body).id).toBe("from-path");
    });

    it("provides query, body, and params on req directly", async () => {
      const handler = vi.fn(({ req }: any) => {
        return { status: 200, body: { query: req.query, body: req.body, params: req.params } };
      });
      const fn = wrapApi(makeHandler({ routes: [{ method: "POST", path: "/create", onRequest: handler }] }));
      const result = await fn(makeEvent({
        requestContext: { http: { method: "POST", path: "/api/create" } },
        queryStringParameters: { q: "search" },
        pathParameters: { id: "123" },
        body: JSON.stringify({ name: "test" }),
      }));
      const body = JSON.parse(result.body);
      expect(body.query).toEqual({ q: "search" });
      expect(body.body).toEqual({ name: "test" });
      expect(body.params).toEqual({ id: "123" });
    });
  });

  // ============ Streaming fallback ============

  describe("streaming", () => {
    it("falls back to buffered mode when awslambda not available", async () => {
      const handler = vi.fn().mockReturnValue({ status: 200, body: "ok" });
      const fn = wrapApi(makeHandler({
        __spec: { basePath: "/api", stream: true } as any,
        routes: [{ method: "GET", path: "/hello", onRequest: handler }],
      } as any));
      const result = await fn(makeEvent());
      expect(result.statusCode).toBe(200);
    });
  });
});
