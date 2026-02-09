---
"effortless-aws": minor
---

Add platform table for observability and fix Lambda layer transitive dependency resolution

**Platform table (observability)**
- Add shared `{project}-{stage}-platform` DynamoDB table with PK/SK and TTL
- New `PlatformClient` with `appendExecution`, `appendError`, `get`, `query`, `put` methods
- Execution logging: daily buckets `HANDLER#<name>` + `EXEC#<YYYY-MM-DD>` with 7-day TTL
- Platform table permissions (PutItem, GetItem, UpdateItem, Query) injected into all Lambda roles
- Fire-and-forget writes via `EFF_PLATFORM_TABLE` env var, no-op when absent

**Runtime refactoring**
- Extract shared `buildDeps` and `buildParams` into `handler-utils.ts` to avoid duplication between HTTP and table stream wrappers
- Simplify `wrap-http.ts` and `wrap-table-stream.ts` by using shared utilities

**Layer transitive dependency fix**
- Track `resolvedPaths: Map<string, string>` through the entire layer build pipeline
- Fix Phase 2 completeness check to inspect all known locations for multi-version packages (pnpm)
- Use resolved paths in `createLayerZip` and `computeLockfileHash` for accurate resolution
- Remove duplicated `findPackagePathForCopy` from CLI layers build command

**DynamoDB**
- Add `ttlAttribute` support to `ensureTable` with `ensureTimeToLive` helper

**Tests**
- Add layer test cases for `resolvedPaths` usage, pnpm nested dep resolution, and multi-version Phase 2 collection
