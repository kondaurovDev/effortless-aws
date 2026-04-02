import { describe, it, expect, beforeAll } from "vitest";
import { env, requireEnv } from "../env";

const site = (path: string) => `${env.siteUrl}${path}`;

beforeAll(() => {
  requireEnv();
  if (!env.siteUrl) {
    throw new Error("SITE_URL is not set. Deploy static-site.ts first.");
  }
});

// ── Static files ────────────────────────────────────────────────

describe("static files", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(site("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Integration Test Site");
  });

  it("serves about.html", async () => {
    const res = await fetch(site("/about.html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("About Page");
  });

  it("serves CSS with correct content-type", async () => {
    const res = await fetch(site("/style.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("serves JS with correct content-type", async () => {
    const res = await fetch(site("/app.js"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.includes("javascript") || ct.includes("application/x-javascript")).toBe(true);
  });

  it("serves JSON with correct content-type", async () => {
    const res = await fetch(site("/data.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ test: true });
  });
});

// ── SPA routing ─────────────────────────────────────────────────

describe("SPA routing", () => {
  it("unknown path returns index.html (SPA fallback)", async () => {
    const res = await fetch(site("/some/deep/route"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Integration Test Site");
  });
});

// ── API route proxying ──────────────────────────────────────────

describe("API proxying via CloudFront", () => {
  it("GET /api/health proxies to Lambda", async () => {
    const res = await fetch(site("/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("GET /api/echo passes query params", async () => {
    const res = await fetch(site("/api/echo?foo=bar"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const query = body.query as Record<string, string>;
    expect(query.foo).toBe("bar");
  });
});

// ── CloudFront signed cookies (private bucket route) ───────────

describe("signed cookies", () => {
  it("unauthenticated request to /files/* returns 403", async () => {
    const res = await fetch(site("/files/test.txt"));
    expect(res.status).toBe(403);
  });

  it("login sets CloudFront signed cookies", async () => {
    const res = await fetch(site("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "cf-test" }),
      redirect: "manual",
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie();
    const cookieNames = setCookie.map(c => c.split("=")[0]);
    expect(cookieNames).toContain("CloudFront-Policy");
    expect(cookieNames).toContain("CloudFront-Signature");
    expect(cookieNames).toContain("CloudFront-Key-Pair-Id");
  });

  it("signed cookies grant access to /files/*", async () => {
    // Login to get signed cookies
    const loginRes = await fetch(site("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "cf-test" }),
      redirect: "manual",
    });
    const setCookie = loginRes.headers.getSetCookie();
    const cookie = setCookie.map(c => c.split(";")[0]).join("; ");

    // Access /files/test.txt with signed cookies — file was pre-uploaded to bucket
    const res = await fetch(site("/files/test.txt"), {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from private storage");
  });
});
