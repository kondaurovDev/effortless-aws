---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Refactor auth: rename `CookieAuth` → `Auth`, `grant()` → `createSession()`, `revoke()` → `clearSession()`. Add automatic 401 gate for non-public paths. Add `apiToken` option to `defineApi` for Bearer/API key authentication with deps access and optional caching.
