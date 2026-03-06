import * as crypto from "crypto";
import type { Duration } from "./handler-options";
import { toSeconds } from "./handler-options";

// ============ Cookie name ============

export const AUTH_COOKIE_NAME = "__eff_session";

// ============ Auth config ============

export type CookieAuthConfig<_T = undefined> = {
  /** Path to redirect unauthenticated users to */
  loginPath: string;
  /** Paths that don't require authentication. Supports trailing `*` wildcard. */
  public?: string[];
  /** Default session lifetime (default: "7d"). Accepts seconds or duration string. */
  expiresIn?: Duration;
};

/**
 * Branded cookie auth object returned by `defineAuth()`.
 * Pass to `defineApi({ auth })` and `defineStaticSite({ auth })`.
 */
export type CookieAuth<T = undefined> = CookieAuthConfig<T> & {
  readonly __brand: "effortless-cookie-auth";
  /** @internal phantom type marker for session data */
  readonly __session?: T;
};

// ============ auth namespace ============

/**
 * Define cookie-based authentication using HMAC-signed tokens.
 *
 * - Middleware (Lambda@Edge) verifies cookie signatures without external calls
 * - API handler gets `auth.grant()` / `auth.revoke()` / `auth.session` helpers
 * - Secret is auto-generated and stored in SSM Parameter Store
 *
 * @typeParam T - Session data type. When provided, `grant(data)` requires typed payload
 *   and `auth.session` is typed as `T` in handler args.
 *
 * @example
 * ```typescript
 * type Session = { userId: string; role: "admin" | "user" };
 *
 * const protect = defineAuth<Session>({
 *   loginPath: '/login',
 *   public: ['/login', '/assets/*'],
 *   expiresIn: '7d',
 * })
 *
 * export const api = defineApi({ auth: protect, ... })
 * export const webapp = defineStaticSite({ auth: protect, ... })
 * ```
 */
export const defineAuth = <T = undefined>(options: CookieAuthConfig<T>): CookieAuth<T> => ({
  __brand: "effortless-cookie-auth",
  ...options,
}) as CookieAuth<T>;

// ============ Runtime helpers (API Lambda) ============

/** Grant options for creating a session */
type GrantOptions = { expiresIn?: Duration };
/** Grant response with Set-Cookie header */
type GrantResponse = { status: 200; body: { ok: true }; headers: Record<string, string> };

/**
 * Auth helpers injected into API handler callback args when `auth` is configured.
 * @typeParam T - Session data type (undefined = no custom data)
 */
export type AuthHelpers<T = undefined> =
  { /** Clear the session cookie. */
    revoke(): { status: 200; body: { ok: true }; headers: Record<string, string> };
    /** The current session data (decoded from cookie). Undefined if no valid session. */
    session: T extends undefined ? undefined : T | undefined;
  }
  & ([T] extends [undefined]
    ? { /** Create a signed session cookie. */ grant(options?: GrantOptions): GrantResponse }
    : { /** Create a signed session cookie with typed data. */ grant(data: T, options?: GrantOptions): GrantResponse });

// ============ Cookie format ============
// Payload: base64url(JSON.stringify({ exp, ...data }))
// Cookie value: {payload}.{hmac-sha256(payload, secret)}

/**
 * Auth runtime created once on cold start. Holds the HMAC key.
 * Call `forRequest(cookieValue)` per request to get typed helpers with decoded session.
 * @internal
 */
export type AuthRuntime = {
  forRequest(cookieValue: string | undefined): AuthHelpers<any>;
};

/**
 * Create auth runtime for an API handler.
 * Called once on cold start with the HMAC secret from SSM.
 * @internal
 */
export const createAuthRuntime = (secret: string, defaultExpiresIn: number): AuthRuntime => {
  const sign = (payload: string): string =>
    crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  const cookieBase = `${AUTH_COOKIE_NAME}=`;
  const cookieAttrs = "; HttpOnly; Secure; SameSite=Lax; Path=/";

  const decodeSession = (cookieValue: string | undefined): unknown => {
    if (!cookieValue) return undefined;
    const dot = cookieValue.indexOf(".");
    if (dot === -1) return undefined;
    const payload = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);
    if (sign(payload) !== sig) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
      if (parsed.exp <= Math.floor(Date.now() / 1000)) return undefined;
      const { exp: _, ...data } = parsed;
      return Object.keys(data).length > 0 ? data : undefined;
    } catch { return undefined; }
  };

  return {
    forRequest(cookieValue) {
      return {
        grant(...args: unknown[]) {
          const hasData = args.length > 0 && (typeof args[0] === "object" && args[0] !== null && !("expiresIn" in args[0]));
          const data = hasData ? args[0] as Record<string, unknown> : undefined;
          const options = (hasData ? args[1] : args[0]) as GrantOptions | undefined;
          const seconds = options?.expiresIn ? toSeconds(options.expiresIn) : defaultExpiresIn;
          const exp = Math.floor(Date.now() / 1000) + seconds;
          const payload = Buffer.from(JSON.stringify({ exp, ...data }), "utf-8").toString("base64url");
          const sig = sign(payload);
          return {
            status: 200 as const,
            body: { ok: true as const },
            headers: {
              "set-cookie": `${cookieBase}${payload}.${sig}${cookieAttrs}; Max-Age=${seconds}`,
            },
          };
        },
        revoke() {
          return {
            status: 200 as const,
            body: { ok: true as const },
            headers: {
              "set-cookie": `${cookieBase}${cookieAttrs}; Max-Age=0`,
            },
          };
        },
        session: decodeSession(cookieValue),
      } as AuthHelpers<any>;
    },
  };
};
