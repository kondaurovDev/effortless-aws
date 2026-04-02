import { describe, it, expect, beforeAll } from "vitest";
import { env, requireEnv } from "../env";

const api = (path: string) => `${env.apiUrl}/test${path}`;
const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeAll(() => {
  requireEnv();
});

// ── Routing ─────────────────────────────────────────────────────

describe("routing", () => {
  it("GET / returns 200", async () => {
    const res = await fetch(api("/"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown path", async () => {
    const res = await fetch(api("/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for wrong method", async () => {
    const res = await fetch(api("/"), { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("HEAD works for GET routes", async () => {
    const res = await fetch(api("/"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

// ── Path parameters ─────────────────────────────────────────────

describe("path params", () => {
  it("extracts single param", async () => {
    const res = await fetch(api("/users/42"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: "42" });
  });

  it("extracts multiple params", async () => {
    const res = await fetch(api("/orgs/acme/members/7"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ orgId: "acme", memberId: "7" });
  });

  it("decodes URI-encoded params", async () => {
    const res = await fetch(api(`/users/${encodeURIComponent("hello world")}`));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: "hello world" });
  });
});

// ── Query parameters ────────────────────────────────────────────

describe("query params", () => {
  it("passes query params to handler", async () => {
    const res = await fetch(api("/search?q=test&page=2"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ q: "test", page: "2" });
  });

  it("missing query params are undefined", async () => {
    const res = await fetch(api("/search"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.q).toBeUndefined();
  });
});

// ── HTTP methods ────────────────────────────────────────────────

describe("HTTP methods", () => {
  it("POST /echo returns body", async () => {
    const res = await fetch(api("/echo"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ message: "hello" });
  });

  it("PUT /items/:id merges body and param", async () => {
    const res = await fetch(api("/items/99"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "updated" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: "99", name: "updated" });
  });

  it("DELETE /items/:id", async () => {
    const res = await fetch(api("/items/99"), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: "99" });
  });
});

// ── Content types ───────────────────────────────────────────────

describe("content types", () => {
  it("returns HTML with correct content-type", async () => {
    const res = await fetch(api("/html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>Hello</h1>");
  });

  it("returns plain text with correct content-type", async () => {
    const res = await fetch(api("/text"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("plain text");
  });

  it("returns JSON by default", async () => {
    const res = await fetch(api("/"));
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// ── Custom headers ──────────────────────────────────────────────

describe("custom headers", () => {
  it("returns custom response headers", async () => {
    const res = await fetch(api("/custom-headers"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom")).toBe("test-value");
  });
});

// ── ok / fail helpers ───────────────────────────────────────────

describe("ok / fail helpers", () => {
  it("fail returns 400 with error message", async () => {
    const res = await fetch(api("/validate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "name is required" });
  });

  it("ok returns custom status code", async () => {
    const res = await fetch(api("/validate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ name: "Alice" });
  });
});

// ── Error handling ──────────────────────────────────────────────

describe("error handling", () => {
  it("unhandled throw returns 500", async () => {
    const res = await fetch(api("/error"));
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error).toBe("Internal server error");
  });
});

// ── Cache ───────────────────────────────────────────────────────

describe("cache", () => {
  it("shorthand: public with max-age, s-maxage, and swr = ttl*2", async () => {
    const res = await fetch(api("/cached"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("public, max-age=30, s-maxage=30, stale-while-revalidate=60");
  });

  it("private scope: no s-maxage or swr", async () => {
    const res = await fetch(api("/cached-private"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("private, max-age=60");
  });

  it("explicit swr override", async () => {
    const res = await fetch(api("/cached-swr"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("public, max-age=10, s-maxage=10, stale-while-revalidate=120");
  });

  it("numeric seconds shorthand", async () => {
    const res = await fetch(api("/cached-num"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=120");
  });

  it("uncached route has no Cache-Control header", async () => {
    const res = await fetch(api("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

// ── Request inspection ──────────────────────────────────────────

describe("request inspection", () => {
  it("receives correct method, path, body", async () => {
    const res = await fetch(api("/inspect?foo=bar"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test": "123" },
      body: JSON.stringify({ data: true }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.method).toBe("POST");
    expect(body.path).toContain("/test/inspect");
    const query = body.query as Record<string, string>;
    const headers = body.headers as Record<string, string>;
    expect(query.foo).toBe("bar");
    expect(body.body).toEqual({ data: true });
    expect(headers["x-test"]).toBe("123");
  });
});
