# effortless-aws

## 0.4.2

### Patch Changes

- [`5503acb`](https://github.com/kondaurovDev/effortless-aws/commit/5503acb3d0b0064d0d3b325ed923ee78a4505c89) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Fix handler file pattern resolution: exact `.ts`/`.tsx` file paths in `handlers` config are now passed through as-is instead of being treated as directories

  Fix static file resolution failing with EISDIR when glob patterns match directories (e.g. `defineSite` with nested `dist/` folder)

## 0.4.1

### Patch Changes

- [`ec73719`](https://github.com/kondaurovDev/effortless-aws/commit/ec7371961046db35b465e3b41ee9050877eabd2f) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Fix handler file pattern resolution: exact `.ts`/`.tsx` file paths in `handlers` config are now passed through as-is instead of being treated as directories

  Fix static file resolution failing with EISDIR when glob patterns match directories (e.g. `defineSite` with nested `dist/` folder)

## 0.4.0

### Minor Changes

- [`ec4daa0`](https://github.com/kondaurovDev/effortless-aws/commit/ec4daa098fe5501f7cf8ca149413bf2fb79e894f) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `defineSite` handler for serving static web content via Lambda and `contentType` shorthand for `defineHttp` responses

## 0.3.0

### Minor Changes

- [`d06cea3`](https://github.com/kondaurovDev/effortless-aws/commit/d06cea324c8718d0ad59213b7671b47e9045d7bf) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add static file bundling for Lambda handlers

  Handlers can now declare `static: ["src/templates/*.ejs"]` to bundle files into the Lambda ZIP. A typed `readStatic(path)` helper is injected into the handler callback args to read bundled files at runtime.

## 0.2.1

### Patch Changes

- [`3c1ca30`](https://github.com/kondaurovDev/effortless-aws/commit/3c1ca308f3ea8731ec65360156251c7a9a61aeb8) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Support custom content-type in HTTP responses: pass body as-is for non-JSON content types instead of always JSON.stringify

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
