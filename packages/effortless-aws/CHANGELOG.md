# effortless-aws

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
