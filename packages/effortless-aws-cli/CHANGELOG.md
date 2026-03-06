# @effortless-aws/cli

## 0.9.1

### Patch Changes

- [`415eda6`](https://github.com/kondaurovDev/effortless-aws/commit/415eda65221f151068d023214292606c016cf7c0) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: add `createRequire` banner to ESM bundles for CJS compatibility

  CJS packages bundled into ESM output (e.g. `follow-redirects`) use `require()` for Node.js builtins, which doesn't exist in ESM context on Lambda. Adds `createRequire(import.meta.url)` banner so bundled CJS code can call `require()` without crashing.

## 0.9.0

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

### Patch Changes

- Updated dependencies [[`be3b35d`](https://github.com/kondaurovDev/effortless-aws/commit/be3b35d821286ed7051dfa861bb35d61c02ab74e)]:
  - effortless-aws@0.24.0

## 0.8.0

### Minor Changes

- [`5ab838f`](https://github.com/kondaurovDev/effortless-aws/commit/5ab838f33cb6aaa8f223fe830fa7b4a2cf2fe3f5) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add update notification that checks npm registry and shows a message when a newer version is available

### Patch Changes

- [`8a4241f`](https://github.com/kondaurovDev/effortless-aws/commit/8a4241fd1d28759b720e3eab9c917f952624fbfd) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: bundle middleware Lambda@Edge standalone to avoid pulling in unrelated dependencies

- Updated dependencies [[`8a4241f`](https://github.com/kondaurovDev/effortless-aws/commit/8a4241fd1d28759b720e3eab9c917f952624fbfd)]:
  - effortless-aws@0.23.1

## 0.7.0

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

### Patch Changes

- Updated dependencies [[`4f7cc91`](https://github.com/kondaurovDev/effortless-aws/commit/4f7cc910fa0aa317469bbc98d6c2181c6ed723b3)]:
  - effortless-aws@0.23.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [[`ceee4a8`](https://github.com/kondaurovDev/effortless-aws/commit/ceee4a854593ab2fd1ac3e19b72e6fcaf0a1ca18), [`ceee4a8`](https://github.com/kondaurovDev/effortless-aws/commit/ceee4a854593ab2fd1ac3e19b72e6fcaf0a1ca18)]:
  - effortless-aws@0.22.0

## 0.5.0

### Minor Changes

- [`796324c`](https://github.com/kondaurovDev/effortless-aws/commit/796324cfb0c57da8fb41a0a15b9460937d6c93cb) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: binary response support and response streaming for defineApi

  - Add `binary` flag to `HttpResponse` for returning binary data (images, PDFs, etc.) with automatic `isBase64Encoded` handling
  - Add `result` helpers (`result.json()`, `result.binary()`) for convenient response construction
  - Add `stream: true` option to `defineApi` for Lambda response streaming and SSE support
  - Add `ResponseStream` type with `write()`, `end()`, `sse()`, `event()` helpers injected into route args
  - Deploy sets `InvokeMode: RESPONSE_STREAM` on Function URL when `stream: true`
  - Backward compatible: streaming routes can still `return { status, body }` as before

### Patch Changes

- Updated dependencies [[`796324c`](https://github.com/kondaurovDev/effortless-aws/commit/796324cfb0c57da8fb41a0a15b9460937d6c93cb)]:
  - effortless-aws@0.21.0

## 0.4.0

### Minor Changes

- [`c1718b7`](https://github.com/kondaurovDev/effortless-aws/commit/c1718b7c4a1a1c02d3d506f6dc9f730181a51e06) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - feat: auto-generate sitemap.xml, robots.txt and submit to Google Indexing API for static sites

  Added `seo` option to `defineStaticSite` that generates sitemap.xml and robots.txt at deploy time. Optionally submits new page URLs to the Google Indexing API for faster crawling. Already-indexed URLs are tracked in S3 and skipped on subsequent deploys.

### Patch Changes

- Updated dependencies [[`c1718b7`](https://github.com/kondaurovDev/effortless-aws/commit/c1718b7c4a1a1c02d3d506f6dc9f730181a51e06)]:
  - effortless-aws@0.20.0

## 0.3.0

### Minor Changes

- [`1bce89f`](https://github.com/kondaurovDev/effortless-aws/commit/1bce89fa5f7e132cd984579d0c41656fd7d9f1ae) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Remove defineHttp, migrate defineApi to Lambda Function URLs, rewrite documentation

### Patch Changes

- Updated dependencies [[`1bce89f`](https://github.com/kondaurovDev/effortless-aws/commit/1bce89fa5f7e132cd984579d0c41656fd7d9f1ae)]:
  - effortless-aws@0.19.0

## 0.2.3

### Patch Changes

- [`0a0c4e7`](https://github.com/kondaurovDev/effortless-aws/commit/0a0c4e7fb362fb1c9f288b618e6949633c532108) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: exclude AWS runtime packages (@aws-sdk/_, @smithy/_, @aws-crypto/_, @aws/_) from Lambda layer and lockfile hash

## 0.2.2

### Patch Changes

- [`f82734a`](https://github.com/kondaurovDev/effortless-aws/commit/f82734a3afa4bd68ad1e260ee0403cb8de65d5bc) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: switch Lambda Function URL to AuthType NONE to fix POST requests through CloudFront OAC

## 0.2.1

### Patch Changes

- [`b14cdb8`](https://github.com/kondaurovDev/effortless-aws/commit/b14cdb874e2f5cdbf04f05e7c2594a0c2b4625a3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: expand CloudFront route patterns so `/prefix/*` also covers bare `/prefix` path

- [`e08d8cd`](https://github.com/kondaurovDev/effortless-aws/commit/e08d8cdf28e33486e1126d85bd94b45e90a03106) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Warn about TypeScript entry points in production dependencies that cause ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING at runtime; show dependency warnings in `eff status` output; fail deploy early when a handler deps key references a missing table/bucket/mailer handler

## 0.2.0

### Minor Changes

- [`cf986fa`](https://github.com/kondaurovDev/effortless-aws/commit/cf986fa18b24eee8d503b6c9bdb02805178a4973) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `root` config option for monorepo support, add `routes` to `defineApp` for CloudFront→API Gateway proxying, add `cleanup --orphaned` flag, add dependency warnings in layer commands, compact CLI help output with better descriptions, refactor config loading to Effect and introduce ProjectConfig service

### Patch Changes

- Updated dependencies [[`cf986fa`](https://github.com/kondaurovDev/effortless-aws/commit/cf986fa18b24eee8d503b6c9bdb02805178a4973)]:
  - effortless-aws@0.18.0

## 0.1.1

### Patch Changes

- [`175e517`](https://github.com/kondaurovDev/effortless-aws/commit/175e5172cbd4c463a810e663a670461e1d8cc2f9) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add README

- Updated dependencies [[`477f35e`](https://github.com/kondaurovDev/effortless-aws/commit/477f35e6269c82c7b1372129b3c9f9542c027030)]:
  - effortless-aws@0.17.0
