# effortless-aws

## 0.2.0

### Minor Changes

- [#5](https://github.com/kondaurovDev/effortless-aws/pull/5) [`eb1274a`](https://github.com/kondaurovDev/effortless-aws/commit/eb1274af142f5600d48fd51a613036695e4f848d) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add platform table for observability and fix Lambda layer transitive dependency resolution

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

## 0.1.0

### Minor Changes

- [#2](https://github.com/kondaurovDev/effortless-aws/pull/2) [`bcc3723`](https://github.com/kondaurovDev/effortless-aws/commit/bcc37235730a953f4d0f18dfcd9403c847b91fff) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add onBatch stream processing, cross-handler deps, SSM params, and typed TableClient

  - **onBatch / onBatchComplete** — new stream processing modes for `defineTable` alongside per-record `onRecord`
  - **deps** — declare `deps: { orders }` to get a typed `TableClient` injected with auto-wired IAM permissions
  - **params** — `param("key")` fetches SSM Parameter Store values at cold start with optional transforms
  - **TableClient** — typed `put`, `get`, `delete`, `query` with lazy DynamoDB SDK initialization
  - **README** — project overview with examples and comparison table

## 0.0.2

### Patch Changes

- [`4608edb`](https://github.com/kondaurovDev/effortless-aws/commit/4608edbc389246404f2f4052fbd0ce961cd21f59) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Restructure project from monorepo to single package
