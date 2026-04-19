---
title: Authentication
description: Protect your API with cookie-based authentication using the .auth() builder method on defineApi.
---

You have an API and some endpoints should only be accessible to logged-in users. You don't want to integrate a third-party auth service or manage JWTs manually.

`.auth()` on `defineApi` gives you cookie-based authentication out of the box. It creates HMAC-signed session cookies, verifies them per-route, and injects typed session helpers into your route handlers.

## How it works

1. Add a `sessionSecret: defineSecret({ generate: "hex:32" })` to your API's `.config(...)`
2. Chain `.auth<Session>(fn)` on the builder — `fn` receives `{ deps, config }` and returns `AuthOptions`
3. Every route handler receives an `auth` arg with `createSession`, `clearSession`, and `session`
4. Mark individual routes as `public: true` in the `RouteDef` to skip authentication

The session is stored in an `HttpOnly; Secure; SameSite=Lax` cookie, signed with HMAC-SHA256. The signing secret is provided explicitly via `defineSecret()` and stored in SSM Parameter Store.

## Full example

```typescript
// src/resources.ts
import { defineApi, defineTable } from "effortless-aws";

type ApiKey = { pk: string; sk: string; role: "admin" | "user" };
type Session = { userId: string; role: "admin" | "user" };

export const apiKeys = defineTable<ApiKey>().build();

export const api = defineApi({ basePath: "/api" })
  .deps(() => ({ apiKeys }))
  .config(({ defineSecret }) => ({
    sessionSecret: defineSecret({ generate: "hex:32" }),
  }))
  .auth<Session>(({ deps, config }) => ({
    secret: config.sessionSecret,
    expiresIn: "7d",
    apiToken: {
      header: "x-api-key",
      verify: async (value: string) => {
        const items = await deps.apiKeys.query({ pk: value });
        const key = items[0];
        if (!key) return null;
        return { userId: key.sk, role: key.data.role };
      },
      cacheTtl: "5m",
    },
  }))
  .get({ path: "/me" }, async ({ auth, ok }) => ok({ session: auth.session }))
  .post({ path: "/login", public: true }, async ({ input, auth }) => {
    const data = parseLogin(input);
    return auth.createSession({ userId: data.userId, role: data.role });
  })
  .post({ path: "/logout" }, async ({ auth }) => auth.clearSession());
```

## `.auth()` options

`.auth<Session>(fn)` takes a factory that returns `AuthOptions<Session>`:

| Option | Description |
|---|---|
| `secret` | **Required.** The HMAC signing secret, typically from `config` via `defineSecret()` |
| `expiresIn` | Session lifetime. Accepts duration strings like `"7d"`, `"1h"`, `"30m"`. Default: `"7d"` |
| `apiToken` | Optional API token authentication (see below) |

The generic `<Session>` controls the shape of data stored in the cookie and returned by `auth.session`.

The factory receives `{ deps, config }` depending on what you've declared with `.deps(...)` and `.config(...)` before `.auth(...)` in the chain. That gives you access to tables, secrets, or any other resource while building the auth configuration.

## Auth helpers in routes

Every route handler receives an `auth` arg. It has three members:

- **`auth.createSession(data)`** — create a signed session cookie. Returns a full `HttpResponse` with a `Set-Cookie` header.
- **`auth.clearSession()`** — clear the session cookie. Returns a response with `Max-Age=0`.
- **`auth.session`** — the decoded session data from the current request's cookie (or verified API token), or `undefined`.

`auth.createSession()` returns a full response object (`{ status: 200, body: { ok: true }, headers: { "set-cookie": "..." } }`), so you can return it directly from a route handler.

## Public routes

By default, all routes require a valid session. To make a route accessible without authentication, add `public: true` to its `RouteDef`:

```typescript
.post({ path: "/login", public: true }, async ({ input, auth }) => {
  // auth.session is undefined here (no cookie yet)
  return auth.createSession({ userId: "u1", role: "user" });
})
.get({ path: "/me" }, async ({ auth, ok }) => {
  // requires valid session — unauthenticated requests get 401
  return ok(auth.session);
})
```

## API token authentication

If your API also needs to support token-based auth (for programmatic clients, CLI tools, etc.), configure `apiToken`:

```typescript
.auth<Session>(({ config, deps }) => ({
  secret: config.sessionSecret,
  apiToken: {
    header: "x-api-key",          // header to read the token from (default: "authorization")
    verify: async (value) => {    // return session data or null
      const items = await deps.apiKeys.query({ pk: value });
      const key = items[0];
      if (!key) return null;
      return { userId: key.sk, role: key.data.role };
    },
    cacheTtl: "5m",               // cache verified tokens in memory
  },
}))
```

When a request arrives, the auth middleware checks for the API token header first. If present, it calls `verify()` and uses the returned data as the session. If not present, it falls back to the session cookie.

## Sharing setup values with routes

`.auth()` configures authentication; values it needs come from `.deps()` and `.config()`. If you also want to pass computed values into routes (e.g. a DB client, a pre-parsed template), chain `.setup()` **after** `.auth()`:

```typescript
.deps(() => ({ apiKeys }))
.config(({ defineSecret }) => ({ sessionSecret: defineSecret(), appName: defineSecret() }))
.auth<Session>(({ config }) => ({ secret: config.sessionSecret }))
.setup(({ deps, config }) => ({
  apiKeys: deps.apiKeys,
  appName: config.appName,
}))
.get({ path: "/me" }, async ({ appName, auth, ok }) =>
  ok({ app: appName, session: auth.session }),
)
```

Note that `deps` and `config` are only available inside `.setup()` and `.auth()`. Route handlers receive the values returned from `.setup()` plus the `auth` helpers.

## How the cookie works

The session cookie format is:

```
__eff_session={base64url(JSON.stringify({ exp, ...data }))}.{hmac-sha256(payload, secret)}
```

- **Payload**: base64url-encoded JSON with an `exp` (Unix timestamp) field and your session data
- **Signature**: HMAC-SHA256 of the payload, using the secret from your `config`
- **Cookie attributes**: `HttpOnly; Secure; SameSite=Lax; Path=/`

`HttpOnly` prevents JavaScript from reading the cookie (XSS protection). `Secure` ensures it's only sent over HTTPS. `SameSite=Lax` prevents CSRF for state-changing requests while allowing normal navigation.

## Custom session data

The generic on `.auth<T>(...)` controls what data is stored in the cookie.

```typescript
// With session data
.auth<{ userId: string; role: string }>(({ config }) => ({
  secret: config.sessionSecret,
}))
// auth.createSession({ userId: "u1", role: "admin" })  — data required
// auth.session?.userId                                  — typed as string
```

Keep session data small — it's stored in the cookie and sent with every request. Store IDs and roles, not large objects.

## Static site authentication

Static sites do not have a built-in `auth` option. If you need to protect a static site, use `.middleware(...)` on `defineStaticSite` for edge-level authentication.

## See also

- [HTTP API guide](/use-cases/http-api) — routes, validation, database access
- [Website guide](/use-cases/web-app) — static sites, SPA mode, middleware
- [Definitions reference — defineApi](/definitions/#defineapi) — all API configuration options
