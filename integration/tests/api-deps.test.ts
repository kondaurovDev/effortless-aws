import { describe, it, expect, beforeAll } from "vitest";
import { env, requireEnv } from "../env";

const api = (path: string) => `${env.apiDepsUrl}/api${path}`;
const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

beforeAll(() => {
  requireEnv();
  if (!env.apiDepsUrl) {
    throw new Error("API_DEPS_URL is not set. Deploy api-with-deps.ts first.");
  }
});

// ── Setup / deps / config ───────────────────────────────────────

describe("setup + deps + config", () => {
  it("health check proves setup ran and deps resolved", async () => {
    const res = await fetch(api("/health"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok", hasTable: true });
  });
});

// ── Auth flow ───────────────────────────────────────────────────

describe("auth", () => {
  it("unauthenticated request to protected route returns 401", async () => {
    const res = await fetch(api("/me"));
    expect(res.status).toBe(401);
  });

  it("api token auth via x-api-key header", async () => {
    // Valid token (matches authSecret)
    const res = await fetch(api("/me"), {
      headers: { "x-api-key": "test-api-token-42" },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.session).toEqual({ userId: "api-token-user" });
  });

  it("invalid api token returns 401", async () => {
    const res = await fetch(api("/me"), {
      headers: { "x-api-key": "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("login → session cookie → /me → logout", async () => {
    // 1. Login
    const loginRes = await fetch(api("/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "test-user" }),
      redirect: "manual",
    });
    expect(loginRes.status).toBe(200);

    // Extract session cookie
    const setCookie = loginRes.headers.getSetCookie();
    expect(setCookie.length).toBeGreaterThan(0);
    const cookie = setCookie.map(c => c.split(";")[0]).join("; ");

    // 2. Access protected route with cookie
    const meRes = await fetch(api("/me"), {
      headers: { cookie },
    });
    expect(meRes.status).toBe(200);
    const me = await json(meRes);
    expect(me.session).toEqual({ userId: "test-user" });

    // 3. Logout
    const logoutRes = await fetch(api("/logout"), {
      method: "POST",
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(200);
  });
});

// ── Table CRUD ──────────────────────────────────────────────────

describe("table CRUD", () => {
  const pk = `test-${Date.now()}`;
  const sk = "note-1";

  it("create note", async () => {
    const res = await fetch(api("/notes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pk, sk, title: "Hello", content: "World" }),
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ created: true });
  });

  it("get note by pk + sk", async () => {
    const res = await fetch(api(`/notes/${pk}/${sk}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as Record<string, unknown>).title).toBe("Hello");
    expect((body.data as Record<string, unknown>).content).toBe("World");
  });

  it("query notes by pk", async () => {
    const res = await fetch(api(`/notes/${pk}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("get non-existent note returns 404", async () => {
    const res = await fetch(api(`/notes/${pk}/does-not-exist`));
    expect(res.status).toBe(404);
  });

  it("delete note", async () => {
    const res = await fetch(api(`/notes/${pk}/${sk}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });

    // Verify deleted
    const check = await fetch(api(`/notes/${pk}/${sk}`));
    expect(check.status).toBe(404);
  });
});

// ── DynamoDB Streams → audit log ───────────────────────────────

describe("table stream", () => {
  const streamPk = `stream-test-${Date.now()}`;
  const streamSk = "note-1";

  /** Poll audit log until at least `count` events matching `type` appear, or timeout */
  async function waitForAudit(
    notePk: string,
    eventType: string,
    count = 1,
    timeoutMs = 30_000,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(api(`/audit/${notePk}`));
      const body = await json(res);
      const items = body.items as Array<{ data: { type: string; notePk: string; noteSk: string } }>;
      const matched = items.filter((i) => i.data.type === eventType);
      if (matched.length >= count) return matched;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`Timed out waiting for ${count} "${eventType}" audit event(s) for pk="${notePk}"`);
  }

  it("INSERT event is captured in audit log", async () => {
    // Create a note
    const res = await fetch(api("/notes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pk: streamPk, sk: streamSk, title: "Stream", content: "Test" }),
    });
    expect(res.status).toBe(201);

    // Wait for stream to process and write audit event
    const events = await waitForAudit(streamPk, "INSERT");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.data.noteSk).toBe(streamSk);
  });

  it("REMOVE event is captured in audit log", async () => {
    // Delete the note created above
    const res = await fetch(api(`/notes/${streamPk}/${streamSk}`), { method: "DELETE" });
    expect(res.status).toBe(200);

    // Wait for REMOVE event
    const events = await waitForAudit(streamPk, "REMOVE");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
