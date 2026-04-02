import * as crypto from "crypto";
import type { Duration } from "./handler-options";
import { toSeconds } from "./handler-options";

// ============ CDN Policy (CloudFront Signed Cookies) ============

/** Options for CloudFront signed cookie policy */
export type CdnPolicyOptions = {
  /** Path pattern to grant access to (e.g., "/files/users/123/*"). Supports `*` and `?` wildcards. */
  path: string;
  /** How long the CDN access is valid (e.g., "1h", "30m") */
  ttl: Duration;
};

/**
 * CloudFront signing configuration, populated at cold start from environment/SSM.
 * @internal
 */
export type CfSigningConfig = {
  /** RSA private key PEM for signing CF cookies */
  privateKey: string;
  /** CloudFront public key ID */
  keyPairId: string;
  /** CloudFront domain (e.g., "d123.cloudfront.net" or "cdn.example.com"), or "*" for wildcard */
  domain: string;
};

/** CloudFront custom base64 encoding: replace characters that are invalid in cookies */
const cfBase64Encode = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");

/**
 * Generate the 3 CloudFront signed cookie values for a custom policy.
 * @internal
 */
export const signCfCookies = (
  policy: CdnPolicyOptions,
  config: CfSigningConfig,
): string[] => {
  const ttlSeconds = toSeconds(policy.ttl);
  const expireTime = Math.floor(Date.now() / 1000) + ttlSeconds;
  const resource = config.domain === "*"
    ? `https://*${policy.path}`
    : `https://${config.domain}${policy.path}`;

  const policyJson = JSON.stringify({
    Statement: [{
      Resource: resource,
      Condition: {
        DateLessThan: { "AWS:EpochTime": expireTime },
      },
    }],
  });

  const policyBase64 = cfBase64Encode(Buffer.from(policyJson, "utf-8"));
  const signature = cfBase64Encode(
    crypto.sign("sha1", Buffer.from(policyJson, "utf-8"), config.privateKey),
  );

  const cookieAttrs = `; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
  return [
    `CloudFront-Policy=${policyBase64}${cookieAttrs}`,
    `CloudFront-Signature=${signature}${cookieAttrs}`,
    `CloudFront-Key-Pair-Id=${config.keyPairId}${cookieAttrs}`,
  ];
};

// ============ Cookie name ============

export const AUTH_COOKIE_NAME = "__eff_session";

// ============ Auth config ============

/** API token authentication strategy nested inside AuthOptions. */
export type ApiTokenStrategy<T> = {
  /** HTTP header to read the token from. Default: "authorization" (strips "Bearer " prefix). */
  header?: string;
  /** Verify the token value and return session data, or null if invalid. */
  verify: (args: { value: string }) => T | null | Promise<T | null>;
  /** Cache verified token results for this duration. Avoids calling verify on every request. */
  cacheTtl?: Duration;
};

/**
 * Auth options for `defineApi({ auth: auth<Session>({ ... }) })`.
 * @typeParam T - Session data type. Typed `createSession(data)` and `auth.session`.
 */
export type AuthOptions<_T = unknown> = {
  /** @internal Brand to carry session type T through to handler args. */
  readonly __sessionType?: _T;
  /** Default session lifetime (default: "7d"). Accepts seconds or duration string. */
  expiresIn?: Duration;
  /** Optional API token strategy for external clients (Bearer tokens, API keys). */
  apiToken?: ApiTokenStrategy<_T>;
};

/**
 * Create typed auth options for `defineApi`.
 * The generic `T` types `createSession(data)` and `auth.session` in handler args.
 *
 * @see {@link https://effortless-aws.website/use-cases/authentication | Authentication guide}
 *
 * @example
 * ```typescript
 * type Session = { userId: string; role: string };
 * defineApi({
 *   basePath: "/api",
 *   auth: auth<Session>({ expiresIn: "7d" }),
 * })
 * ```
 */
export const auth = <T = unknown>(options?: {
  expiresIn?: Duration;
  apiToken?: ApiTokenStrategy<T>;
}): AuthOptions<T> =>
  (options ?? {}) as AuthOptions<T>;


// ============ Runtime helpers (API Lambda) ============

/** Options for creating a session */
type SessionOptions = {
  expiresIn?: Duration;
  /** CloudFront signed cookie policy for CDN-level access control */
  cdnPolicy?: CdnPolicyOptions;
};
/** Session response with Set-Cookie headers */
type SessionResponse = { status: 200; body: { ok: true }; headers: Record<string, string>; cookies?: string[] };

/**
 * Auth helpers injected into API handler callback args when `auth` is configured.
 * @typeParam T - Session data type (from `AuthOptions<T>`)
 */
export type AuthHelpers<T = unknown> = {
  /** Create a signed session cookie with typed data. */
  createSession(data: T, options?: SessionOptions): SessionResponse;
  /** Clear the session cookie. */
  clearSession(): { status: 200; body: { ok: true }; headers: Record<string, string> };
  /** The current session data (from cookie or API token). Undefined if no valid session. */
  session: T | undefined;
};

// ============ Cookie format ============
// Payload: base64url(JSON.stringify({ exp, ...data }))
// Cookie value: {payload}.{hmac-sha256(payload, secret)}

/**
 * Auth runtime created once on cold start. Holds the HMAC key and optional token verifier.
 * Call `forRequest(cookieValue, authHeader, deps)` per request to get typed helpers.
 * @internal
 */
export type AuthRuntime = {
  forRequest(cookieValue: string | undefined, authHeader: string | undefined): Promise<AuthHelpers<any>>;
};

/**
 * Create auth runtime for an API handler.
 * Called once on cold start with the HMAC secret from SSM.
 * @internal
 */
export const createAuthRuntime = (
  secret: string,
  defaultExpiresIn: number,
  apiTokenVerify?: (args: { value: string }) => unknown | Promise<unknown>,
  apiTokenHeader?: string,
  apiTokenCacheTtlSeconds?: number,
  cfSigningConfig?: CfSigningConfig,
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
    createSession(data: Record<string, unknown>, options?: SessionOptions) {
      const seconds = options?.expiresIn ? toSeconds(options.expiresIn) : defaultExpiresIn;
      const exp = Math.floor(Date.now() / 1000) + seconds;
      const payload = Buffer.from(JSON.stringify({ exp, ...data }), "utf-8").toString("base64url");
      const sig = sign(payload);
      const sessionCookie = `${cookieBase}${payload}.${sig}${cookieAttrs}; Max-Age=${seconds}`;

      // Generate CloudFront signed cookies if cdnPolicy is provided and CF signing is configured
      const cfCookies = options?.cdnPolicy && cfSigningConfig
        ? signCfCookies(options.cdnPolicy, cfSigningConfig)
        : undefined;

      return {
        status: 200 as const,
        body: { ok: true as const },
        headers: {
          "set-cookie": sessionCookie,
        },
        ...(cfCookies ? { cookies: [sessionCookie, ...cfCookies] } : {}),
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
    async forRequest(cookieValue: string | undefined, authHeader: string | undefined) {
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

        const session = await apiTokenVerify({ value: tokenValue });

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
