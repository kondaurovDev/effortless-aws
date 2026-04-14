---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

- Lazy AWS SDK imports: SDK clients are now loaded via dynamic `import()` instead of static imports, reducing Lambda cold start time for handlers that don't use all SDK clients
- Added `preload()` method to `HandlerRuntime` and `__preload` hooks on all wrappers for INIT-phase SDK pre-loading
- New `eff stats` CLI command showing Lambda performance metrics (invocations, duration percentiles, cold starts, memory, concurrency, cost)
- Fixed `access: "private"` for bucket routes in static site extraction
- Fixed single-handler deploy to resolve secrets (EFF_PARAM_* env vars)
