import * as crypto from "crypto";
import type { Duration } from "./handler-options";
import { toSeconds } from "./handler-options";

// ============ Cookie name ============

export const AUTH_COOKIE_NAME = "__eff_session";

// ============ Auth config ============

export type AuthConfig<_T = undefined> = {
  /** Path to redirect unauthenticated users to (used by static sites). */
  loginPath: string;
  /** Paths that don't require authentication. Supports trailing `*` wildcard. */
  public?: string[];
  /** Default session lifetime (default: "7d"). Accepts seconds or duration string. */
  expiresIn?: Duration;
};

/**
 * Branded auth object returned by `defineAuth()`.
 * Pass to `defineApi({ auth })` and `defineStaticSite({ auth })`.
 */
export type Auth<T = undefined> = AuthConfig<T> & {
  readonly __brand: "effortless-auth";
  /** @internal phantom type marker for session data */
  readonly __session?: T;
};

// ============ API Token strategy (used by defineApi) ============

/** API token authentication strategy. Verifies tokens from HTTP headers (e.g. Authorization: Bearer). */
export type ApiTokenStrategy<T, D = undefined> = {
  /** HTTP header to read the token from. Default: "authorization" (strips "Bearer " prefix). */
  header?: string;
  /** Verify the token value and return session data, or null if invalid. */
  verify: [D] extends [undefined]
    ? (value: string) => T | null | Promise<T | null>
    : (value: string, ctx: { deps: D }) => T | null | Promise<T | null>;
  /** Cache verified token results for this duration. Avoids calling verify on every request. */
  cacheTtl?: Duration;
};

// ============ defineAuth ============

/**
 * Define authentication for API handlers and static sites.
 *
 * Session-based auth uses HMAC-signed cookies (auto-managed by the framework).
 *
 * - Lambda@Edge middleware verifies cookie signatures for static sites
 * - API handler gets `auth.createSession()` / `auth.clearSession()` / `auth.session` helpers
 * - HMAC secret is auto-generated and stored in SSM Parameter Store
 *
 * @typeParam T - Session data type. When provided, `createSession(data)` requires typed payload
 *   and `auth.session` is typed as `T` in handler args.
 *
 * @example
 * ```typescript
 * type Session = { userId: string; role: "admin" | "user" };
 *
 * const auth = defineAuth<Session>({
 *   loginPath: '/login',
 *   public: ['/login', '/api/login'],
 *   expiresIn: '7d',
 * })
 *
 * export const api = defineApi({ auth, ... })
 * export const webapp = defineStaticSite({ auth, ... })
 * ```
 */
export const defineAuth = <T = undefined>(options: AuthConfig<T>): Auth<T> => ({
  __brand: "effortless-auth",
  ...options,
}) as Auth<T>;

// ============ Runtime helpers (API Lambda) ============

/** Options for creating a session */
type SessionOptions = { expiresIn?: Duration };
/** Session response with Set-Cookie header */
type SessionResponse = { status: 200; body: { ok: true }; headers: Record<string, string> };

/**
 * Auth helpers injected into API handler callback args when `auth` is configured.
 * @typeParam T - Session data type (undefined = no custom data)
 */
export type AuthHelpers<T = undefined> =
  { /** Clear the session cookie. */
    clearSession(): { status: 200; body: { ok: true }; headers: Record<string, string> };
    /** The current session data (from cookie or API token). Undefined if no valid session. */
    session: T extends undefined ? undefined : T | undefined;
  }
  & ([T] extends [undefined]
    ? { /** Create a signed session cookie. */ createSession(options?: SessionOptions): SessionResponse }
    : { /** Create a signed session cookie with typed data. */ createSession(data: T, options?: SessionOptions): SessionResponse });

// ============ Cookie format ============
// Payload: base64url(JSON.stringify({ exp, ...data }))
// Cookie value: {payload}.{hmac-sha256(payload, secret)}

/**
 * Auth runtime created once on cold start. Holds the HMAC key and optional token verifier.
 * Call `forRequest(cookieValue, authHeader, deps)` per request to get typed helpers.
 * @internal
 */
export type AuthRuntime = {
  forRequest(cookieValue: string | undefined, authHeader: string | undefined, deps?: Record<string, unknown>): Promise<AuthHelpers<any>>;
};

/**
 * Create auth runtime for an API handler.
 * Called once on cold start with the HMAC secret from SSM.
 * @internal
 */
export const createAuthRuntime = (
  secret: string,
  defaultExpiresIn: number,
  apiTokenVerify?: (value: string, ctx: { deps: unknown }) => unknown | Promise<unknown>,
  apiTokenHeader?: string,
  apiTokenCacheTtlSeconds?: number,
): AuthRuntime => {
  // Token verification cache: token → { session, expiresAt }
  const tokenCache = apiTokenCacheTtlSeconds
    ? new Map<string, { session: unknown; expiresAt: number }>()
    : undefined;

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

  const extractTokenValue = (headerValue: string): string => {
    const isDefaultHeader = !apiTokenHeader || apiTokenHeader.toLowerCase() === "authorization";
    if (isDefaultHeader && headerValue.toLowerCase().startsWith("bearer ")) {
      return headerValue.slice(7);
    }
    return headerValue;
  };

  const buildHelpers = (sessionData: unknown): AuthHelpers<any> => ({
    createSession(...args: unknown[]) {
      const hasData = args.length > 0 && (typeof args[0] === "object" && args[0] !== null && !("expiresIn" in args[0]));
      const data = hasData ? args[0] as Record<string, unknown> : undefined;
      const options = (hasData ? args[1] : args[0]) as SessionOptions | undefined;
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
    clearSession() {
      return {
        status: 200 as const,
        body: { ok: true as const },
        headers: {
          "set-cookie": `${cookieBase}${cookieAttrs}; Max-Age=0`,
        },
      };
    },
    session: sessionData,
  } as AuthHelpers<any>);

  return {
    async forRequest(cookieValue, authHeader, deps) {
      // API token takes priority over cookie
      if (authHeader && apiTokenVerify) {
        const tokenValue = extractTokenValue(authHeader);

        // Check cache
        if (tokenCache) {
          const cached = tokenCache.get(tokenValue);
          if (cached && cached.expiresAt > Date.now()) {
            return buildHelpers(cached.session);
          }
        }

        const session = await apiTokenVerify(tokenValue, { deps });

        // Store in cache
        if (tokenCache && apiTokenCacheTtlSeconds) {
          tokenCache.set(tokenValue, { session, expiresAt: Date.now() + apiTokenCacheTtlSeconds * 1000 });
        }

        return buildHelpers(session);
      }

      // Fall back to cookie-based session
      return buildHelpers(decodeSession(cookieValue));
    },
  };
};
