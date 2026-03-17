---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Redesign handler API: clear config → setup → callback scoping, route-based defineApi, explicit auth

**New design principle: `config`/`deps` → `setup` → callbacks**

- `deps` and `config` are now available **only in `setup`**, not in callbacks
- `setup` return properties are **spread directly into callback args** (no `ctx` wrapper)
- This applies to all handlers: `defineApi`, `defineTable`, `defineFifoQueue`, `defineBucket`

**Breaking changes to `defineApi`:**

- `get`/`post` replaced with `routes: [{ path: "GET /users", onRequest }]` array
- Global `schema` removed — validation is per-route inside `onRequest`
- `auth` top-level option removed — use `enableAuth` helper injected into `setup` args
- HMAC secret is now explicit via `config: { secret: secret() }`, not auto-provisioned

**Breaking changes to all handlers (`defineTable`, `defineFifoQueue`, `defineBucket`):**

- Callbacks (`onRecord`, `onMessage`, `onObjectCreated`, etc.) no longer receive `deps`, `config`, or `ctx`
- Wire dependencies through `setup` and access them as spread properties in callbacks

**Batch callbacks with partial failure support:**

- `defineTable`: new `onRecordBatch` callback — called once per batch, mutually exclusive with `onRecord`. Return `{ failures: string[] }` (sequence numbers) for partial batch failure
- `defineFifoQueue`: `onBatch` renamed to `onMessageBatch`, mutually exclusive with `onMessage`. Now supports returning `{ failures: string[] }` (messageIds) for partial batch failure

**Authentication:**

- `defineAuth()` removed
- `enableAuth<Session>(options)` is injected into `setup` args (no import needed)
- `auth.grant()` → `auth.createSession()`, `auth.revoke()` → `auth.clearSession()`
- `auth` option removed from `defineStaticSite` — use `middleware` for edge auth

**Removed from deploy:**

- Auto-provisioned auth secret (`collectAuthSecret`, `EFF_AUTH_SECRET`)
- Auth config AST extraction (`extractAuthConfig`, `AuthConfig` type)
