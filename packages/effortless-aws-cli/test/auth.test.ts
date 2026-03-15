import { describe, it, expect } from "vitest"
import { createHmac } from "crypto"
import { createAuthRuntime, AUTH_COOKIE_NAME, type AuthHelpers } from "~aws/handlers/auth"

const SECRET = "test-secret-key-12345";

/** Helper to build a valid cookie value for testing */
const buildCookie = (data: Record<string, unknown>, secret = SECRET) => {
  const payload = Buffer.from(JSON.stringify(data), "utf-8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
};

describe("auth helpers", async () => {

  describe("createSession (no session data)", async () => {
    it("should return 200 with Set-Cookie header", async () => {
      const rt = createAuthRuntime(SECRET, 604800);
      const auth = await rt.forRequest(undefined, undefined);
      const result = auth.createSession();

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(result.headers["set-cookie"]).toContain(`${AUTH_COOKIE_NAME}=`);
      expect(result.headers["set-cookie"]).toContain("HttpOnly");
      expect(result.headers["set-cookie"]).toContain("Secure");
      expect(result.headers["set-cookie"]).toContain("SameSite=Lax");
      expect(result.headers["set-cookie"]).toContain("Max-Age=604800");
    });

    it("should produce a valid HMAC-signed base64url payload cookie", async () => {
      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(undefined, undefined);
      const result = auth.createSession();

      const cookie = result.headers["set-cookie"]!;
      const match = cookie.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
      expect(match).toBeTruthy();
      const value = match![1]!;
      const [payload, sig] = value.split(".");
      expect(payload).toBeTruthy();
      expect(sig).toBeTruthy();

      // Verify the signature
      const expected = createHmac("sha256", SECRET)
        .update(payload!)
        .digest("base64url");
      expect(sig).toBe(expected);

      // Decode payload and verify exp
      const data = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
      expect(data.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("should respect custom expiresIn", async () => {
      const rt = createAuthRuntime(SECRET, 604800);
      const auth = await rt.forRequest(undefined, undefined);
      const result = auth.createSession({ expiresIn: "1h" });

      expect(result.headers["set-cookie"]).toContain("Max-Age=3600");
    });
  });

  describe("createSession (with session data)", async () => {
    it("should encode custom data in payload", async () => {
      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(undefined, undefined) as AuthHelpers<{ userId: string; role: string }>;
      const result = auth.createSession({ userId: "u123", role: "admin" });

      const cookie = result.headers["set-cookie"]!;
      const match = cookie.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`))!;
      const [payload] = match[1]!.split(".");

      const data = JSON.parse(Buffer.from(payload!, "base64url").toString("utf-8"));
      expect(data.userId).toBe("u123");
      expect(data.role).toBe("admin");
      expect(data.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("should accept expiresIn as second arg when data is provided", async () => {
      const rt = createAuthRuntime(SECRET, 604800);
      const auth = await rt.forRequest(undefined, undefined) as AuthHelpers<{ userId: string }>;
      const result = auth.createSession({ userId: "u1" }, { expiresIn: "2h" });

      expect(result.headers["set-cookie"]).toContain("Max-Age=7200");
    });
  });

  describe("session (cookie)", async () => {
    it("should decode session from valid cookie", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const cookie = buildCookie({ exp, userId: "u123", role: "admin" });

      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(cookie, undefined);

      expect(auth.session).toEqual({ userId: "u123", role: "admin" });
    });

    it("should return undefined for expired cookie", async () => {
      const exp = Math.floor(Date.now() / 1000) - 100;
      const cookie = buildCookie({ exp, userId: "u123" });

      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(cookie, undefined);

      expect(auth.session).toBeUndefined();
    });

    it("should return undefined for invalid signature", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const cookie = buildCookie({ exp, userId: "u123" }, "wrong-secret");

      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(cookie, undefined);

      expect(auth.session).toBeUndefined();
    });

    it("should return undefined when no cookie provided", async () => {
      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(undefined, undefined);

      expect(auth.session).toBeUndefined();
    });

    it("should return undefined for cookie with only exp (no custom data)", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const cookie = buildCookie({ exp });

      const rt = createAuthRuntime(SECRET, 3600);
      const auth = await rt.forRequest(cookie, undefined);

      expect(auth.session).toBeUndefined();
    });
  });

  describe("session (apiToken)", async () => {
    it("should resolve session from sync token verify", async () => {
      const verify = (token: string) => token === "valid" ? { userId: "t1" } : null;
      const rt = createAuthRuntime(SECRET, 3600, verify);
      const auth = await rt.forRequest(undefined, "Bearer valid");

      expect(auth.session).toEqual({ userId: "t1" });
    });

    it("should resolve session from async token verify", async () => {
      const verify = async (token: string) => token === "valid" ? { userId: "t1" } : null;
      const rt = createAuthRuntime(SECRET, 3600, verify);
      const auth = await await rt.forRequest(undefined, "Bearer valid");

      expect(auth.session).toEqual({ userId: "t1" });
    });

    it("should return null session for invalid token", async () => {
      const verify = (token: string) => token === "valid" ? { userId: "t1" } : null;
      const rt = createAuthRuntime(SECRET, 3600, verify);
      const auth = await rt.forRequest(undefined, "Bearer wrong");

      expect(auth.session).toBeNull();
    });

    it("should prioritize apiToken over cookie", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const cookie = buildCookie({ exp, userId: "cookie-user" });
      const verify = (token: string) => token === "valid" ? { userId: "token-user" } : null;

      const rt = createAuthRuntime(SECRET, 3600, verify);
      const auth = await rt.forRequest(cookie, "Bearer valid");

      expect(auth.session).toEqual({ userId: "token-user" });
    });

    it("should fall back to cookie when no auth header", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const cookie = buildCookie({ exp, userId: "cookie-user" });
      const verify = (_token: string) => ({ userId: "token-user" });

      const rt = createAuthRuntime(SECRET, 3600, verify);
      const auth = await rt.forRequest(cookie, undefined);

      expect(auth.session).toEqual({ userId: "cookie-user" });
    });

    it("should use custom header name without stripping Bearer prefix", async () => {
      const verify = (value: string) => ({ apiKey: value });
      const rt = createAuthRuntime(SECRET, 3600, verify, "x-api-key");
      const auth = await rt.forRequest(undefined, "my-raw-key");

      expect(auth.session).toEqual({ apiKey: "my-raw-key" });
    });
  });

  describe("clearSession", async () => {
    it("should return 200 with Max-Age=0 to clear cookie", async () => {
      const rt = createAuthRuntime(SECRET, 604800);
      const auth = await rt.forRequest(undefined, undefined);
      const result = auth.clearSession();

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(result.headers["set-cookie"]).toContain(`${AUTH_COOKIE_NAME}=`);
      expect(result.headers["set-cookie"]).toContain("Max-Age=0");
    });
  });

});
