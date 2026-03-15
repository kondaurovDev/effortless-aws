# effortless-aws

## 0.27.1

### Patch Changes

- [`008216e`](https://github.com/kondaurovDev/effortless-aws/commit/008216e582be37a587a8350ce39a5c68774c26c5) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Enforce leading slash in `defineApi` route keys and `basePath` via template literal types, normalize double slashes in route matching

## 0.27.0

### Minor Changes

- [`d33c492`](https://github.com/kondaurovDev/effortless-aws/commit/d33c49257e06491dce7e37a2498c5870c53fd271) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add automatic dead-letter queue (DLQ) for FIFO queues. A `*-dlq.fifo` queue is now created alongside every FIFO queue with a configurable `maxReceiveCount` (default: 3).

## 0.26.0

### Minor Changes

- [`c78c078`](https://github.com/kondaurovDev/effortless-aws/commit/c78c0783a9ca2afa55b2c865370ebc725d803070) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: add `onAfterInvoke` lifecycle hook for all handler types

  New optional callback executed after each Lambda invocation completes, right before the process freezes. Useful for flushing batched logs/metrics, checking buffers, or any cleanup that needs CPU time before Lambda suspends the execution environment.

  Supported on: `defineApi`, `defineTable`, `defineFifoQueue`, `defineBucket`.

  ```typescript
  export default defineApi({
    basePath: "/api",
    onAfterInvoke: async ({ ctx, deps }) => {
      if (buffer.length >= 100) await flush();
    },
    // ...
  });
  ```

## 0.25.0

### Minor Changes

- [`bab8e7a`](https://github.com/kondaurovDev/effortless-aws/commit/bab8e7a7ab4b2eb8dbdb8524d127217e4415bf1e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add ctx/deps/config/files to onError callbacks in defineTable, defineFifoQueue, defineBucket, and defineApi. Extract shared `HandlerArgs` utility type to reduce duplication across callback types.

  **Breaking**: `onError` now receives a single object argument instead of positional args.

  Before: `onError: (error) => { ... }`
  After: `onError: ({ error }) => { ... }`

  For defineApi, `req` is also included: `onError: ({ error, req }) => { ... }`

### Patch Changes

- [`9e03702`](https://github.com/kondaurovDev/effortless-aws/commit/9e03702ce75bd66638208a427c5435675a82d717) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `increment` action to TableClient.update() for atomic numeric field increments/decrements

## 0.24.1

### Patch Changes

- [`2d82fd2`](https://github.com/kondaurovDev/effortless-aws/commit/2d82fd27953e8ef1cf1151562253cf64ea73683e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix(auth): resolve defineAuth config from shorthand properties and fix crypto import for ESM bundles

## 0.24.0

### Minor Changes

- [`be3b35d`](https://github.com/kondaurovDev/effortless-aws/commit/be3b35d821286ed7051dfa861bb35d61c02ab74e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: add `defineAuth()` for HMAC-signed cookie authentication

  - `defineAuth<Session>({ loginPath, public, expiresIn })` creates a typed auth config
  - `defineApi({ auth })` injects typed `auth.grant(data)` / `auth.revoke()` / `auth.session` into handler args
  - `defineStaticSite({ auth })` auto-generates Lambda@Edge middleware that verifies signed cookies
  - Session data encoded as base64url JSON payload in cookie, signed with HMAC-SHA256
  - HMAC secret is auto-generated and stored in SSM Parameter Store
  - Stateless verification at edge — no external API calls needed

  fix(cli): monorepo layer support and large layer uploads

  - Auto-derive `extraNodeModules` from `root` config — when `projectDir !== cwd`, search `projectDir/node_modules` for layer packages (pnpm/npm/yarn compatible)
  - Upload large layers (>50 MB) via S3 instead of direct API call to avoid 70 MB `PublishLayerVersion` limit
  - Fix false "TypeScript entry points" warnings for packages like zod and @standard-schema/spec that use custom export conditions (`@zod/source`, `standard-schema-spec`) — now only standard runtime conditions (`import`, `require`, `default`, `node`) are checked
  - Filter packages without resolved paths from layer (cosmetic fix)

## 0.23.1

### Patch Changes

- [`8a4241f`](https://github.com/kondaurovDev/effortless-aws/commit/8a4241fd1d28759b720e3eab9c917f952624fbfd) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: bundle middleware Lambda@Edge standalone to avoid pulling in unrelated dependencies

## 0.23.0

### Minor Changes

- [`4f7cc91`](https://github.com/kondaurovDev/effortless-aws/commit/4f7cc910fa0aa317469bbc98d6c2181c6ed723b3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - refactor: deps is now always a function, rename typed to unsafeAs

  **Breaking changes:**

  - `deps` must be declared as a function: `deps: () => ({ orders })` (object shorthand `deps: { orders }` is no longer supported)
  - `typed<T>()` helper removed — use `unsafeAs<T>()` instead

  **Improvements:**

  - `unsafeAs<T>()` replaces `typed<T>()` with a clearer name signaling no runtime validation
  - Handler type annotations (`TableHandler`, `FifoQueueHandler`, `BucketHandler`) now accept any `setup` return type without needing explicit generics
  - Simplified internal type exports — removed unused callback/options types from public API
  - CLI handler registry updated to parse arrow-function deps syntax

## 0.22.0

### Minor Changes

- [`ceee4a8`](https://github.com/kondaurovDev/effortless-aws/commit/ceee4a854593ab2fd1ac3e19b72e6fcaf0a1ca18) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Lambda settings (`memory`, `timeout`, `logLevel`, `permissions`) moved from top-level handler options into a nested `lambda` object. Global config `defaults` renamed to `lambda`.

  ```typescript
  // Before
  defineFifoQueue({ memory: 512, timeout: "1m", delay: "2s" });
  defineConfig({ defaults: { memory: 256 } });

  // After
  defineFifoQueue({ lambda: { memory: 512, timeout: "1m" }, delay: "2s" });
  defineConfig({ lambda: { memory: 256 } });
  ```

- [`ceee4a8`](https://github.com/kondaurovDev/effortless-aws/commit/ceee4a854593ab2fd1ac3e19b72e6fcaf0a1ca18) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: QueueClient — FIFO queues as deps for typed message sending

  - `QueueClient<T>` with `send()` and `sendBatch()` methods
  - FIFO queue handlers can now be used in `deps: { myQueue }` declarations
  - `ResolveDeps` maps `FifoQueueHandler<T>` to `QueueClient<T>` with full type inference
  - Deploy resolves queue deps to `EFF_DEP_<key>=queue:<name>` env vars with SQS IAM permissions
  - Runtime lazily resolves queue URL via `getQueueUrl` (cached after first call)
  - Deploy now applies `delay` (DelaySeconds) when creating/updating FIFO queues

## 0.21.0

### Minor Changes

- [`796324c`](https://github.com/kondaurovDev/effortless-aws/commit/796324cfb0c57da8fb41a0a15b9460937d6c93cb) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: binary response support and response streaming for defineApi

  - Add `binary` flag to `HttpResponse` for returning binary data (images, PDFs, etc.) with automatic `isBase64Encoded` handling
  - Add `result` helpers (`result.json()`, `result.binary()`) for convenient response construction
  - Add `stream: true` option to `defineApi` for Lambda response streaming and SSE support
  - Add `ResponseStream` type with `write()`, `end()`, `sse()`, `event()` helpers injected into route args
  - Deploy sets `InvokeMode: RESPONSE_STREAM` on Function URL when `stream: true`
  - Backward compatible: streaming routes can still `return { status, body }` as before

## 0.20.0

### Minor Changes

- [`c1718b7`](https://github.com/kondaurovDev/effortless-aws/commit/c1718b7c4a1a1c02d3d506f6dc9f730181a51e06) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: auto-generate sitemap.xml, robots.txt and submit to Google Indexing API for static sites

  Added `seo` option to `defineStaticSite` that generates sitemap.xml and robots.txt at deploy time. Optionally submits new page URLs to the Google Indexing API for faster crawling. Already-indexed URLs are tracked in S3 and skipped on subsequent deploys.

## 0.19.0

### Minor Changes

- [`1bce89f`](https://github.com/kondaurovDev/effortless-aws/commit/1bce89fa5f7e132cd984579d0c41656fd7d9f1ae) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Remove defineHttp, migrate defineApi to Lambda Function URLs, rewrite documentation

## 0.18.0

### Minor Changes

- [`cf986fa`](https://github.com/kondaurovDev/effortless-aws/commit/cf986fa18b24eee8d503b6c9bdb02805178a4973) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `root` config option for monorepo support, add `routes` to `defineApp` for CloudFront→API Gateway proxying, add `cleanup --orphaned` flag, add dependency warnings in layer commands, compact CLI help output with better descriptions, refactor config loading to Effect and introduce ProjectConfig service

## 0.17.0

### Minor Changes

- [`477f35e`](https://github.com/kondaurovDev/effortless-aws/commit/477f35e6269c82c7b1372129b3c9f9542c027030) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `defineApi` and `defineApp` handlers, export `typed` helper
