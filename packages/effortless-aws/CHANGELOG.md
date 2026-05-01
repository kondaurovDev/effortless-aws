# effortless-aws

## 0.39.0

### Minor Changes

- [`663a111`](https://github.com/kondaurovDev/effortless-aws/commit/663a1117a943a07842cf3592bae8fce6ba8d15d8) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - defineApi: auto-detect binary response bodies, add `downloadAs` for forcing downloads, rename `files.readBuffer` → `files.readBytes`.

  - `body: Uint8Array | Buffer | Blob` is now detected automatically — the runtime base64-encodes it and sets `isBase64Encoded: true`. `Blob.type` is used as `Content-Type` when not set explicitly. The legacy `binary: true` flag with a base64 string body still works.
  - New `downloadAs?: string` response field sets `Content-Disposition: attachment; filename="<value>"`. Works with any body type (JSON, text, binary). Non-ASCII filenames get an RFC 5987 `filename*=UTF-8''…` form for compatibility. An explicit `Content-Disposition` header overrides `downloadAs`.
  - **Breaking:** `files.readBuffer(path): Buffer` renamed to `files.readBytes(path): Uint8Array` for cross-platform typing. The implementation still uses `readFileSync` under the hood, and `Buffer` methods remain available on the returned value (since `Buffer extends Uint8Array`) — only the static type changed.

  Example:

  ```ts
  .get({ path: "/script/shortcut" }, ({ files }) => ({
    status: 200,
    body: files.readBytes("infra/static/budget-shortcut.signed.shortcut"),
    downloadAs: "family-budget.shortcut",
  }))
  ```

## 0.38.0

### Minor Changes

- [`4bcd7ed`](https://github.com/kondaurovDev/effortless-aws/commit/4bcd7ed7cb3c51dc3c3b02248b83ef25c81893b3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Reconcile stale resources on deploy when a handler switches to resource-only mode, and add `.build()` to `defineQueue`.

  **The problem.** The deploy pipeline was forward-only — it created whatever the config asked for, but didn't remove what a previous deploy had created when the config shrank. Switching `defineTable().onRecord(...)` → `defineTable().build()` (or the bucket equivalent) left the Lambda, DLQ, IAM role, and event-source mapping orphaned in AWS. Users had to run `cleanup --stale` to get rid of them.

  **What changes.**

  - **Resource registry** (`@effortless-aws/cli`): `ResourceSpec` gains a `requiresHandler` flag marking resources that only exist when a handler function is attached. A new `cleanupStaleHandlerResources(handlerType, ctx)` helper deletes just those.
  - **Deploy paths** (`@effortless-aws/cli`): `deploy-table.ts`, `deploy-bucket.ts`, and `deploy-queue.ts` call the helper in their `!hasHandler` branches. The primary resource (table / bucket / queue) is preserved; Lambda + IAM (+ DLQ for tables) are removed if they existed from a previous deploy.
  - **Bucket notification** (`@effortless-aws/cli`): added `clearBucketNotification` — in resource-only mode the S3 bucket's `NotificationConfiguration` is cleared so it no longer points at a deleted Lambda.
  - **Stream reconcile** (`@effortless-aws/cli`): `ensureTable` now reconciles the DynamoDB stream spec (enable / disable / change view) rather than only enabling it. Combined with the above, switching a table to `.build()` correctly disables the stream.
  - **`defineQueue.build()`** (`effortless-aws`): new terminal on the queue builder that finalizes a resource-only SQS queue (no Lambda). Useful when the queue is consumed by an external system — an ECS worker, another account, etc.
  - **MCP warning** (`@effortless-aws/cli`): `deploy` now logs a warning when an MCP handler has no tools, resources, or prompts registered.

  **Behavioral note.** Resource-only tables and buckets will, on the next deploy, actively remove any satellite resources left over from previous deploys. If you had a stream or notification wired to something outside of this CLI's management, re-check after deploying.

- [`4bcd7ed`](https://github.com/kondaurovDev/effortless-aws/commit/4bcd7ed7cb3c51dc3c3b02248b83ef25c81893b3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Rename `defineFifoQueue` → `defineQueue` with `fifo` as a queue option, and move event-source-mapping settings into a dedicated `.poller({...})` builder method.

  **Rationale**: the new shape prepares the ground for standard (non-FIFO) queue support and cleanly separates queue-resource properties from poller/ESM properties (which in AWS live on a different resource — the Event Source Mapping).

  **Breaking — no compatibility alias**:

  - `defineFifoQueue(...)` → `defineQueue({ fifo: true, ... })`
  - Top-level `batchSize`/`batchWindow` options move into `.poller({ batchSize, batchWindow })`, called before the terminal `.onMessage` / `.onMessageBatch`
  - Exported types renamed: `FifoQueueHandler` → `QueueHandler`, `FifoQueueMessage` → `QueueMessage`, `FifoQueueConfig` → `QueueConfig`; new `QueuePollerConfig` exported
  - Handler brand changed from `"effortless-fifo-queue"` to `"effortless-queue"`

  Migration:

  ```ts
  // before
  export const orderQueue = defineFifoQueue<Order>({ batchSize: 5 })
    .onMessage(async ({ message }) => { ... })

  // after
  export const orderQueue = defineQueue<Order>({ fifo: true })
    .poller({ batchSize: 5 })
    .onMessage(async ({ message }) => { ... })
  ```

  Only `fifo: true` is currently supported; standard-queue semantics (including the typed client `.send()` signature without `messageGroupId`) will arrive in a follow-up release.

- [`4bcd7ed`](https://github.com/kondaurovDev/effortless-aws/commit/4bcd7ed7cb3c51dc3c3b02248b83ef25c81893b3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Fix silent failures in DynamoDB table stream handlers and split stream options into a dedicated `.stream()` builder method.

  **Previously** table stream errors were silently swallowed: the runtime returned `batchItemFailures` but the event source mapping was created without `FunctionResponseTypes: ["ReportBatchItemFailures"]`, so AWS ignored the response, there was no retry, and no DLQ.

  **Now**:

  - Event source mapping sets `FunctionResponseTypes: ["ReportBatchItemFailures"]`, `BisectBatchOnFunctionError: true`, `MaximumRetryAttempts` (from `maxRetries`, default 1) and an `OnFailure` destination.
  - Every table with a stream handler gets a standard SQS DLQ `{project}-{stage}-{handler}-dlq`, created automatically and cleaned up on teardown.
  - Failed records are retried with AWS's built-in exponential backoff; once retries are exhausted AWS sends a pointer to the failed record into the DLQ.

  **Breaking**: stream-related options moved out of `defineTable({...})` into a new `.stream({...})` builder method. Affected options: `batchSize`, `batchWindow`, `concurrency`, `startingPosition`, `streamView`.

  Migration:

  ```ts
  // before
  export const orders = defineTable<Order>({
    batchSize: 10,
    concurrency: 5,
    streamView: "NEW_AND_OLD_IMAGES",
  })
    .onRecord(async ({ record }) => { ... })

  // after
  export const orders = defineTable<Order>()
    .stream({
      batchSize: 10,
      concurrency: 5,
      maxRetries: 1,
      streamView: "NEW_AND_OLD_IMAGES",
    })
    .onRecord(async ({ record }) => { ... })
  ```

## 0.37.0

### Minor Changes

- [`c0a72bd`](https://github.com/kondaurovDev/effortless-aws/commit/c0a72bd0edddaa9a27649ac9577383d4029e5bf4) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Lazy AWS SDK imports: SDK clients are now loaded via dynamic `import()` instead of static imports, reducing Lambda cold start time for handlers that don't use all SDK clients
  - Added `preload()` method to `HandlerRuntime` and `__preload` hooks on all wrappers for INIT-phase SDK pre-loading
  - New `eff stats` CLI command showing Lambda performance metrics (invocations, duration percentiles, cold starts, memory, concurrency, cost)
  - Fixed `access: "private"` for bucket routes in static site extraction
  - Fixed single-handler deploy to resolve secrets (EFF*PARAM*\* env vars)

## 0.36.1

### Patch Changes

- [`0a8b758`](https://github.com/kondaurovDev/effortless-aws/commit/0a8b75820f8b238122a42a507254f6d7a8496b5e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Fix `any` type inference in `defineStaticSite` builder methods by adding explicit `StaticSiteBuilder` return type

## 0.36.0

### Minor Changes

- [`b59ce0d`](https://github.com/kondaurovDev/effortless-aws/commit/b59ce0d0fa9c4210b04d7f9c975268189e61dd5b) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Add `.auth()` builder method to `defineApi` and `defineMcp` for configuring authentication

  - Remove `enableAuth` from `.setup()` options in favor of the new `.auth()` method

- [`b59ce0d`](https://github.com/kondaurovDev/effortless-aws/commit/b59ce0d0fa9c4210b04d7f9c975268189e61dd5b) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Refactor `defineDistribution` back to `defineStaticSite` with a builder pattern: `.route()`, `.middleware()`, `.build()`
  - Replace `spa: boolean` option with unified `errorPage` field for custom error page handling

## 0.35.0

### Minor Changes

- [`60663ff`](https://github.com/kondaurovDev/effortless-aws/commit/60663ff6efe0d7cdb91ec5137157c2601e931051) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Add Standard Schema support to `defineApi` routes via an optional `schema` field for input validation
  - Add Standard Schema support to `defineMcp` tools for typed input validation
  - Export new `McpEntries` type and rename `McpToolDef` to use `McpToolDefInput` internally
  - Fix lint errors (unused imports/variables) and remove outdated MCP tests

## 0.34.0

### Minor Changes

- [`f683d8c`](https://github.com/kondaurovDev/effortless-aws/commit/f683d8ce0e8025571d66740fa9673062000703d9) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Add `defineMcp` handler for building MCP (Model Context Protocol) servers with tools, resources, and prompts
  - Add deployment support for MCP handlers via Lambda-backed Streamable HTTP endpoints
  - Add `seed` and `sync` options to `defineBucket` for uploading local files to S3 on deploy
  - Fix `effortless-aws` being incorrectly placed in Lambda layer instead of inlined in the bundle

## 0.33.1

### Patch Changes

- [`4183258`](https://github.com/kondaurovDev/effortless-aws/commit/41832588bb9a37c8d77da97eb8daf35536c20f1c) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - - Add bucket routes in static sites with public/private access (CloudFront signed cookies)
  - Add SPA fallback mode for static sites (extensionless paths rewrite to /index.html)
  - Deploy API routes to per-handler Lambda origins instead of shared API Gateway
  - Add cache options for GET routes (auto Cache-Control headers)
  - Support multiple set-cookie headers via Lambda Function URL cookies array
  - Use custom CloudFront cache policy (UseOriginCacheHeaders) for API behaviors

## 0.33.0

### Minor Changes

- [`6ecba64`](https://github.com/kondaurovDev/effortless-aws/commit/6ecba64b179a7daf64185a5c0ed1d477e59e15f9) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Remove `root` option from EffortlessConfig. Project root is now always resolved from the current working directory.

## 0.32.1

### Patch Changes

- [`a04ce2e`](https://github.com/kondaurovDev/effortless-aws/commit/a04ce2efc30f4aeefcbb39e9920cd88e40cb004e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Fix path parameter routing for Lambda Function URLs. Routes with `{param}` patterns (e.g. `/templates/{id}`) now correctly match incoming requests and extract parameters into `req.params` and `input`.

## 0.32.0

### Minor Changes

- [`c1d14c8`](https://github.com/kondaurovDev/effortless-aws/commit/c1d14c8b63c3bb748b68749c9d8f1756db5802fa) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `defineWorker` handler for long-running ECS Fargate tasks with typed `FargateSize` presets

- [`b2d85a7`](https://github.com/kondaurovDev/effortless-aws/commit/b2d85a7735a10ac93ac4b7b0d25dedced06e831e) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Support async onError handlers across all handler types and fix worker logs to use ECS log group path

## 0.31.0

### Minor Changes

- [`01eaba3`](https://github.com/kondaurovDev/effortless-aws/commit/01eaba37c49655c56e2d3d02799d0add0c3283a5) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - ### New: `defineCron` — scheduled Lambda via EventBridge Scheduler

  ```typescript
  export const cleanup = defineCron({ schedule: "rate(2 hours)" }).onTick(
    async () => {
      /* ... */
    }
  );

  export const sync = defineCron({
    schedule: "cron(0 18 ? * MON-FRI *)",
    timezone: "Europe/Moscow",
  })
    .deps(() => ({ orders }))
    .setup(async ({ deps }) => ({ db: deps.orders }), { memory: 512 })
    .onTick(async ({ db }) => {
      /* ... */
    });
  ```

  - `schedule` with typed rate expressions (`rate(5 minutes)`) and cron
  - `timezone` with full IANA autocomplete (418 zones, DST-aware)
  - Same builder pattern: `.deps()`, `.config()`, `.include()`, `.setup()`, `.onTick()`
  - Deploy creates EventBridge Scheduler + Lambda + IAM roles

  ### API redesign: `.setup()` for Lambda config, `.include()` for static files

  All handlers (`defineTable`, `defineApi`, `defineFifoQueue`, `defineBucket`, `defineCron`):

  - **Lambda config moved to `.setup()`**: `memory`, `timeout`, `permissions`, `logLevel` are no longer in the options object
    - `.setup({ memory: 512, timeout: "5m" })` — lambda config only
    - `.setup(fn, { memory: 512 })` — init function + lambda config
  - **`.include(glob)` replaces `static` option**: chainable, can be called multiple times
    - `.include("templates/*.html").include("assets/**")`

  ### Deploy output improvements

  - Cron handlers shown in deploy summary with schedule expression and timezone
  - Warnings (layer, bundle size) deferred until after progress spinner

## 0.30.0

### Minor Changes

- [`65c9078`](https://github.com/kondaurovDev/effortless-aws/commit/65c9078c80995b84f35516aa648ebd8d09194dfe) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Redesign handler API to builder pattern with per-step type inference

  - **defineApi**: single options object `defineApi({ basePath })`, chained route methods `.get()/.post()/.put()/.patch()/.delete()` instead of `.routes([])` array
  - **defineTable/defineFifoQueue/defineBucket**: builder pattern with `.deps()`, `.config()`, `.setup()` methods instead of curried `define*()({...})` syntax
  - **Terminal methods**: `.onRecord()`, `.onMessage()`, `.onObjectCreated()`, `.routes()` finalize the handler — no `.build()` needed (except resource-only)
  - **Response helpers**: `ok(body, status?)` and `fail(message, status?)` injected into route args, setup, and onError — replaces `result.json()`
  - **onCleanup**: renamed from `onAfterInvoke`, moved to builder method with setup context access
  - **CLI warning**: detect unfinalized builders and suggest the correct terminal method

## 0.29.0

### Minor Changes

- [`4767d5a`](https://github.com/kondaurovDev/effortless-aws/commit/4767d5a307d16c26ef0f2bdb0a97d0780d8ee19a) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Redesign handler API: clear config → setup → callback scoping, route-based defineApi, explicit auth

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

## 0.28.0

### Minor Changes

- [`85f0fdf`](https://github.com/kondaurovDev/effortless-aws/commit/85f0fdf2ee1d0e194a0df023c935902f3f949ca7) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Refactor auth: rename `CookieAuth` → `Auth`, `grant()` → `createSession()`, `revoke()` → `clearSession()`. Add automatic 401 gate for non-public paths. Add `apiToken` option to `defineApi` for Bearer/API key authentication with deps access and optional caching.

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
