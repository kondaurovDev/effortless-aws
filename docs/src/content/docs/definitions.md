---
title: Definitions
description: All handler definition types available in Effortless.
---

## Overview

Every resource in Effortless is created with a `define*` function. Each call declares **what** you need — the framework handles the infrastructure.

Most definitions return a **fluent builder**. You chain calls like `.deps(...)`, `.config(...)`, `.setup(...)`, `.include(...)`, and finish with a terminal method such as `.onRecord(...)`, `.onMessage(...)`, `.get(...)`, or `.build()` (for resource-only handlers).

| Definition | Description |
|---|---|
| [defineApi](#defineapi) | HTTP API with routes |
| [defineTable](#definetable) | DynamoDB table with optional stream processing |
| [defineApp](#defineapp) | SSR app with CloudFront |
| [defineStaticSite](#definestaticsite) | Static site with CloudFront |
| [defineQueue](#definequeue) | SQS FIFO queue with message processing |
| [defineCron](#definecron) | Scheduled Lambda (cron / rate) |
| [defineBucket](#definebucket) | S3 bucket with optional event handlers |
| [defineWorker](#defineworker) | Long-running Fargate worker with an SQS queue |
| [defineMailer](#definemailer) | SES email identity for sending emails |
| [defineMcp](#definemcp) | MCP server with tools, resources, and prompts |

Resource-only definitions are useful when you need the infrastructure but handle it from elsewhere. A `defineTable` without stream callbacks creates a DynamoDB table, a `defineBucket` without event callbacks creates an S3 bucket, and a `defineMailer` creates an SES email identity — all referenceable via `deps`:

```typescript
// Just a table — no Lambda, no stream
export const users = defineTable<User>().build();

// Just a bucket — no Lambda, no event notifications
export const uploads = defineBucket().build();

// API that writes to the table and bucket
export const api = defineApi({ basePath: "/users" })
  .deps(() => ({ users, uploads }))
  .setup(({ deps }) => ({ users: deps.users, uploads: deps.uploads }))
  .post({ path: "/upload" }, async ({ users, uploads }) => {
    await users.put({
      pk: "USER#1", sk: "PROFILE",
      data: { tag: "user", name: "Alice", email: "alice@example.com" },
    });
    await uploads.put("avatars/user-1.png", avatarBuffer);
    return { status: 201, body: { ok: true } };
  });
```

---

## Type inference

The builder is designed so every method sets exactly one generic. TypeScript infers everything from your chain — you rarely need to spell out the generics yourself.

Always use `schema` when the data crosses a boundary. Items in DynamoDB streams, SQS messages, and HTTP request bodies are external input — even if you wrote the producer yourself. Schemas evolve, fields get renamed, old records linger in streams after a migration, and a queue may contain messages sent before your latest deploy. A `schema` function is the single place that catches these mismatches at runtime instead of letting bad data silently flow through your logic.

For **runtime validation** (recommended), pass a real validation function — Zod, Effect Schema, or plain TypeScript — to the options object, and use the builder for everything else:

```typescript
import { z } from "zod";

const Order = z.object({
  tag: z.string(),
  amount: z.number(),
  status: z.enum(["pending", "paid", "shipped"]),
});

export const orders = defineTable({
  schema: (input) => Order.parse(input), // validates + infers T = { tag, amount, status }
})
  .deps(() => ({ users }))
  .config(({ defineSecret }) => ({ threshold: defineSecret({ key: "threshold" }) }))
  .setup(({ deps, config }) => ({
    users: deps.users,
    db: createPool(config.threshold),
  }))
  .onRecord(async ({ record, users, db }) => {
    // record.new?.data is z.infer<typeof Order> | undefined
    // users is TableClient<User> (from setup return)
    // db is Pool (from setup return)
  });
```

For **typing without runtime validation** (prototyping or when you trust the data shape), pass the type as a generic — `defineTable<Order>()`:

```typescript
type Order = { tag: string; amount: number; status: string };

export const orders = defineTable<Order>()
  .onRecord(async ({ record }) => {
    // record.new?.data is Order | undefined
  });
```

---

## Shared builder methods

These methods are available on every Lambda-backed handler (`defineApi`, `defineTable`, `defineQueue`, `defineBucket`, `defineCron`, `defineMcp`, `defineWorker`). They're chainable and return the builder so you can keep composing.

### `.deps(fn)`

Declare dependencies on other handlers (tables, buckets, queues, mailers, workers). The framework auto-wires environment variables, IAM permissions, and injects typed clients at runtime — `TableClient<T>` for tables, `BucketClient` for buckets, `EmailClient` for mailers, `QueueClient<T>` for queues, `WorkerClient<T>` for workers.

**Deps are available in `.setup(...)` only** — wire them into the setup return to use in callbacks.

```typescript
import { orders } from "./orders.js";
import { uploads } from "./uploads.js";
import { mailer } from "./mailer.js";

.deps(() => ({ orders, uploads, mailer }))
// → deps.orders is TableClient<Order>
// → deps.uploads is BucketClient
// → deps.mailer is EmailClient
```

### `.config(fn)`

Declare SSM Parameter Store secrets. The factory receives `{ defineSecret }` and returns a record of secret references. Values are fetched once on cold start and cached. **Config values are available in `.setup(...)` only** — wire them into the setup return to use in callbacks.

```typescript
.config(({ defineSecret }) => ({
  dbUrl: defineSecret({ key: "database-url" }),
  appConfig: defineSecret({ key: "app-config", transform: JSON.parse }),
  sessionSecret: defineSecret({ generate: "hex:32" }),   // auto-generate on first deploy
}))
// → config.dbUrl is string
// → config.appConfig is ReturnType<typeof JSON.parse>
// → config.sessionSecret is string
```

SSM path is built automatically: `/${project}/${stage}/${key}`. When `key` is omitted, the property name is used (kebab-cased).

### `.include(glob)`

Bundle static files into the Lambda ZIP by glob pattern. Chainable — call it multiple times to include multiple patterns. At runtime, read them via the `files` argument inside `.setup(...)`.

```typescript
.include("src/templates/*.ejs")
.include("assets/logo.png")
.setup(({ files }) => ({
  template: files.read("src/templates/invoice.ejs"),
}))
```

### `.setup(fn)` / `.setup(fn, lambda)` / `.setup(lambda)`

Initializes shared state on cold start. The return value is cached and its properties are **spread directly into callback arguments** — no `ctx` wrapper.

The factory receives `{ deps?, config?, files? }` depending on what you've declared before it. The optional second argument (or first, if you only want Lambda settings) configures the Lambda itself: `{ memory, timeout, permissions, logLevel }`.

```typescript
// Lambda settings only, no init
.setup({ memory: 512, timeout: "1m" })

// Cold-start init, no Lambda overrides
.setup(({ deps, config }) => ({
  users: deps.users,
  pool: createPool(config.dbUrl),
}))
// → callbacks receive: { users, pool, ...otherArgs }

// Both: init + Lambda settings
.setup(async ({ deps }) => ({ db: deps.orders }), { memory: 1024 })
```

### `.onError(fn)`

Runs when a handler callback throws. Receives `{ error, ...setupReturn }` (plus type-specific extras like `req` for APIs, `toolName` for MCP, `msg` + `retryCount` for workers).

- **HTTP (`defineApi`)**: return an `HttpResponse` to shape the error response.
- **Stream / queue / bucket / cron**: defaults to `console.error` if omitted.
- **Worker (`defineWorker`)**: return `"retry"` (default) or `"delete"` to control SQS redelivery.

```typescript
.onError(({ error, req, fail }) => {
  console.error("Handler failed:", error);
  return fail("Something went wrong", 500);
})
```

### `.onCleanup(fn)`

Runs after each Lambda invocation completes, right before the process freezes. This is the only reliable place to run code between invocations — `setInterval` and background tasks don't execute while Lambda is frozen.

Receives the setup return as arguments. Supports async. If `onCleanup` throws, the error is logged but does **not** affect the handler's response.

```typescript
const buffer: LogEntry[] = [];

export const api = defineApi({ basePath: "/api" })
  .onCleanup(async () => {
    // Flush batched logs when buffer is large or stale
    if (buffer.length >= 100 || timeSinceLastFlush() > 30_000) {
      await flush(buffer);
    }
  })
  .get({ path: "/users" }, async ({ req }) => {
    buffer.push({ path: req.path, time: Date.now() });
    return { status: 200, body: users };
  });
```

:::tip[Lambda lifecycle]
Understanding how Lambda manages your process helps explain why `onCleanup` exists:

1. **Cold start** — Lambda creates a new execution environment. Your module loads, `setup` runs once.
2. **Invoke** — Lambda thaws the process, runs your handler, returns the response.
3. **Freeze** — Lambda immediately suspends the process (CPU off, event loop paused). No timers fire, no `setInterval` callbacks run, no pending promises resolve.
4. **Repeat** — on the next request, Lambda thaws the same process from step 2. Variables, connections, and caches survive across invocations.
5. **Shutdown** — after ~5–15 minutes of inactivity, Lambda sends `SIGTERM` and destroys the environment.

The freeze between steps 2 and 3 is the key insight: `onCleanup` runs at the end of step 2, giving you CPU time before the process is suspended. Without it, you'd have no way to run cleanup logic between invocations.
:::

### `.auth<A>(fn)` — HTTP only

Available on `defineApi` and `defineMcp`. Configures session-based authentication. The factory receives `{ deps?, config? }` and returns `AuthOptions<A>`.

See [defineApi → Authentication](#authentication) for a full example.

---

## defineApi

Creates: Lambda + Function URL with built-in routing

`defineApi` is the primary way to build HTTP APIs. It deploys **one Lambda** with a Function URL that handles all routing internally — no API Gateway needed.

- **Builder chain** — `.deps()`, `.config()`, `.include()`, `.auth()`, `.setup()`, `.onError()`, `.onCleanup()` — all chainable.
- **Routes** — `.get(def, handler)`, `.post(def, handler)`, `.put(def, handler)`, `.patch(def, handler)`, `.delete(def, handler)`. `def` is a `RouteDef` object: `{ path, input?, public?, cache? }`.
- Setup return properties are spread into route handler args.
- Unmatched routes return 404 automatically.

### Options

| Option | Type | Description |
|---|---|---|
| `basePath` | `` `/${string}` `` | **Required.** Prefix for all routes (e.g. `"/api"`). |
| `stream` | `boolean` | Enable response streaming (SSE). Routes receive a `stream` arg. |

### Builder chain

```typescript
export const api = defineApi({ basePath: "/api" })
  .deps(() => ({ ... }))
  .config(({ defineSecret }) => ({ ... }))
  .include("glob")
  .auth<Session>(({ config, deps }) => ({ ... }))
  .setup(({ deps, config, files }) => C, { memory: 512 })
  .onError(({ error, req, fail }) => fail("oops", 500))
  .onCleanup(() => { /* ... */ })
  .get({ path: "/users" }, async ({ req, ...ctx }) => ({ status: 200, body: [] }))
  .post({ path: "/login", public: true }, async ({ input, auth }) =>
    auth.createSession({ userId: "..." }),
  );
```

### Route definition

Every route method takes a `RouteDef` object as the first argument:

| Field | Type | Description |
|---|---|---|
| `path` | `` `/${string}` `` | Route path (supports `{name}` params). |
| `input` | `StandardSchemaV1?` | Optional validator (Zod, Valibot, Arktype, ...). When set, `input` in the handler is typed. |
| `public` | `boolean?` | Skip authentication for this route (only meaningful when `.auth()` is set). |
| `cache` | `CacheOptions?` | `GET`-only. Duration shorthand (`"30s"`) or `{ ttl, swr?, scope? }`. |

### Route handler arguments

All route handlers receive a single object with:

| Arg | Type | Description |
|---|---|---|
| `req` | `HttpRequest` | Full HTTP request (method, path, headers, query, body, rawBody, params). |
| `input` | `InferInput<schema>` / `unknown` | Validated body when `input` schema is set; otherwise raw merged query + body. |
| `ok` | `OkHelper` | `ok(body?, status?)` — shorthand for `{ status, body }`. |
| `fail` | `FailHelper` | `fail(message, status?)` — shorthand error response. |
| `stream` | `ResponseStream` | Only when `stream: true` on the API. |
| `auth` | `AuthHelpers<A>` | Only when `.auth()` is configured. |
| `...ctx` | spread | All properties returned from `.setup(...)`, spread directly. |

### Authentication

Auth is configured via `.auth<Session>(fn)`. The factory receives `{ deps, config }` (whichever you've declared) and returns `AuthOptions`:

```typescript
import { defineApi, defineTable } from "effortless-aws";

type ApiKey = { pk: string; sk: string; role: "admin" | "user" };
type Session = { userId: string; role: "admin" | "user" };

export const apiKeys = defineTable<ApiKey>().build();

export const api = defineApi({ basePath: "/api" })
  .deps(() => ({ apiKeys }))
  .config(({ defineSecret }) => ({ sessionSecret: defineSecret({ generate: "hex:32" }) }))
  .auth<Session>(({ deps, config }) => ({
    secret: config.sessionSecret,
    expiresIn: "7d",
    apiToken: {
      header: "x-api-key",
      verify: async (value) => {
        const items = await deps.apiKeys.query({ pk: value });
        const key = items[0];
        if (!key) return null;
        return { userId: key.sk, role: key.data.role };
      },
      cacheTtl: "5m",
    },
  }))
  .get({ path: "/me" }, async ({ auth, ok }) => ok({ session: auth.session }))
  .post({ path: "/login", public: true }, async ({ input, auth }) => {
    const { userId, role } = input as { userId: string; role: "admin" | "user" };
    return auth.createSession({ userId, role });
  })
  .post({ path: "/logout" }, async ({ auth }) => auth.clearSession());
```

Auth helpers in route args:
- `auth.createSession(data)` — create signed session cookie, returns a full `HttpResponse`.
- `auth.clearSession()` — clear session cookie.
- `auth.session` — current session data (`A | undefined`).
- Routes without `public: true` require a valid session (401 if missing).
- API token takes priority over cookie when both are present.

### Dependencies via setup

```typescript
import { orders } from "./orders.js";

export const api = defineApi({ basePath: "/orders" })
  .deps(() => ({ orders }))
  .setup(({ deps }) => ({ orders: deps.orders }))
  .post({ path: "/create" }, async ({ orders, input, ok }) => {
    await orders.put({
      pk: "USER#123", sk: "ORDER#456",
      data: { tag: "order", ...(input as Record<string, unknown>) },
    });
    return ok({}, 201);
  });
```

Dependencies are auto-wired: the framework sets environment variables, IAM permissions, and provides typed `TableClient` instances at runtime. Deps are available in `.setup()` only — spread them into callbacks via the setup return.

**Built-in best practices**:
- **Lambda Function URL** — no API Gateway overhead, lower latency, zero cost for the URL itself.
- **Single Lambda** — shared cold start, deps, and setup across all routes. One function to deploy and keep warm.
- **Built-in CORS** — permissive CORS headers configured automatically on the Function URL.
- **Cold start optimization** — the `setup` factory runs once on cold start and is cached across invocations.
- **Typed dependencies** — `deps` provides typed `TableClient<T>`, `BucketClient`, and `EmailClient` instances with auto-wired IAM permissions.
- **Auto-infrastructure** — Lambda, Function URL, and IAM permissions are created on deploy.

---

## defineTable

Creates: DynamoDB Table + (optional) Stream + Lambda + Event Source Mapping

Every table uses an opinionated **single-table design** with a fixed structure:

| Attribute | Type | Purpose |
|-----------|------|---------|
| `pk` | String | Partition key |
| `sk` | String | Sort key |
| `tag` | String | Entity type discriminant (auto-extracted from your data) |
| `data` | Map | Your domain data (typed as `T`) |
| `ttl` | Number | Optional TTL (always enabled, set to auto-expire items) |

Your domain type `T` is what goes inside `data`. The envelope (`pk`, `sk`, `tag`, `ttl`) is managed by effortless.

### Options

| Option | Type | Description |
|---|---|---|
| `schema` | `(input: unknown) => T` | Decode/validate function for `data` in stream records. |
| `billingMode` | `"PAY_PER_REQUEST" \| "PROVISIONED"` | Default: `PAY_PER_REQUEST`. |
| `tagField` | `keyof T` | Field in `data` used as the entity discriminant. Default: `"tag"`. |

### Builder chain

```typescript
export const orders = defineTable<Order>({ billingMode: "PAY_PER_REQUEST" })
  .deps(() => ({ ... }))
  .config(({ defineSecret }) => ({ ... }))
  .include("glob")
  .stream({ batchSize: 10, concurrency: 5, maxRetries: 3 })    // stream event source mapping
  .setup(({ table, deps, config, files }) => C, { memory: 512 })
  .onError(({ error }) => { /* ... */ })
  .onCleanup(() => { /* ... */ })
  // Terminal — pick one:
  .onRecord(async ({ record, batch, ...ctx }) => { /* ... */ });
  // .onRecordBatch(async ({ records, ...ctx }) => { /* ... */ });
  // .build();   // resource-only, no Lambda
```

### `.stream(opts)` — stream event source mapping

Call before the terminal. Can be called at most once.

| Option | Type | Description |
|---|---|---|
| `streamView` | `"NEW_AND_OLD_IMAGES" \| "NEW_IMAGE" \| "OLD_IMAGE" \| "KEYS_ONLY"` | Default: `NEW_AND_OLD_IMAGES`. |
| `batchSize` | `number` | 1–10000, default 100. |
| `batchWindow` | `Duration` | Default `"2s"`. |
| `startingPosition` | `"LATEST" \| "TRIM_HORIZON"` | Default: `LATEST`. |
| `concurrency` | `number` | Default 1 (sequential). |
| `maxRetries` | `number` | Default 1. |

### Type inference

Use `schema` for runtime validation, or pass the type as a generic for typing without validation. `T` is the domain data stored inside the `data` attribute — not the full DynamoDB item.

```typescript
import { defineTable } from "effortless-aws";

type Order = { tag: string; amount: number; status: string };

// Option 1: type-only via generic — no runtime validation
export const orders = defineTable<Order>().build();

// Option 2: schema function — with runtime validation
export const orders = defineTable({
  schema: (input: unknown) => {
    const obj = input as Record<string, unknown>;
    if (typeof obj?.amount !== "number") throw new Error("amount required");
    return { tag: String(obj.tag), amount: obj.amount, status: String(obj.status) };
  },
}).build();
```

### Tag field (`tagField`)

Every item has a top-level `tag` attribute in DynamoDB (useful for GSIs and filtering). Effortless auto-extracts it from your data — by default from `data.tag`. If your discriminant field is named differently, set `tagField`:

```typescript
type Order = { type: "order"; amount: number };

export const orders = defineTable<Order>({
  tagField: "type",  // → extracts data.type as the DynamoDB tag attribute
}).build();
```

### Callback arguments

All stream callbacks (`onRecord`, `onRecordBatch`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `record` / `records` | `TableRecord<T>` / `readonly TableRecord<T>[]` | Stream records with typed `new`/`old` `TableItem<T>` values. |
| `batch` (in `onRecord`) | `readonly TableRecord<T>[]` | Full batch the record came from, for context. |
| `...ctx` | spread | All properties from setup return, spread directly. |

`deps` and `config` are available in `.setup()` only — wire them into the setup return to use in callbacks. `table` (the self-client) is available inside `.setup(...)` as `args.table`.

Stream records follow the `TableItem<T>` structure:

```typescript
record.eventName      // "INSERT" | "MODIFY" | "REMOVE"
record.new?.pk        // string
record.new?.sk        // string
record.new?.tag       // string (entity discriminant)
record.new?.data      // T (your typed domain data)
record.new?.ttl       // number | undefined
record.keys           // { pk: string; sk: string }
```

### Per-record processing

```typescript
export const orders = defineTable<Order>()
  .onRecord(async ({ record }) => {
    if (record.eventName === "INSERT" && record.new) {
      console.log(`New order: $${record.new.data.amount}`);
    }
  });
```

Each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`.

### Batch processing

```typescript
export const events = defineTable<ClickEvent>()
  .stream({ batchSize: 100 })
  .onRecordBatch(async ({ records }) => {
    const inserts = records
      .filter((r) => r.eventName === "INSERT")
      .map((r) => r.new!.data);
    await bulkIndex(inserts);
  });
```

All records in a batch are processed together. If the handler throws, all records are reported as failed. Return `{ failures: string[] }` with sequence numbers for partial batch failure reporting.

### TableClient

Every table handler's `.setup()` receives a `table: TableClient<T>` — a typed client for its own table. Other handlers get it via `deps`. `T` is your domain data type (what goes inside `data`).

```typescript
TableClient<T>
  put(item: PutInput<T>, options?: { ifNotExists?: boolean }): Promise<void>
  get(key: { pk: string; sk: string }): Promise<TableItem<T> | undefined>
  delete(key: { pk: string; sk: string }): Promise<void>
  update(key: { pk: string; sk: string }, actions: UpdateActions<T>): Promise<void>
  query(params: QueryParams): Promise<TableItem<T>[]>
  tableName: string
```

**put** — writes an item. Tag is auto-extracted from `data[tagField]`. Use `{ ifNotExists: true }` to prevent overwriting existing items.

```typescript
await table.put({
  pk: "USER#123", sk: "ORDER#456",
  data: { tag: "order", amount: 100, status: "new" },
});

// Conditional write — fails if item already exists
await table.put(
  { pk: "USER#123", sk: "ORDER#456", data: { tag: "order", amount: 100, status: "new" } },
  { ifNotExists: true },
);
```

**get / delete** — by partition key + sort key:

```typescript
const item = await table.get({ pk: "USER#123", sk: "ORDER#456" });
// item: { pk, sk, tag, data: Order, ttl? } | undefined

await table.delete({ pk: "USER#123", sk: "ORDER#456" });
```

**update** — partial updates without reading the full item. `set`, `append`, and `remove` target fields inside `data` (effortless auto-prefixes `data.` in the DynamoDB expression). `tag` and `ttl` update top-level attributes.

```typescript
await table.update({ pk: "USER#123", sk: "ORDER#456" }, {
  set: { status: "shipped" },         // SET data.status = "shipped"
  append: { tags: ["priority"] },     // Append to data.tags list
  remove: ["tempField"],              // REMOVE data.tempField
  tag: "shipped-order",               // Update top-level tag
  ttl: 1700000000,                    // Set TTL (null to remove)
});
```

**query** — by partition key with optional sort key conditions:

```typescript
// All orders for a user
const orders = await table.query({ pk: "USER#123" });

// Orders with sk prefix
const orders = await table.query({ pk: "USER#123", sk: { begins_with: "ORDER#" } });

// Sort key conditions:
sk: "exact-value"                 // =
sk: { begins_with: "PREFIX" }     // begins_with(sk, :v)
sk: { gt: "value" }               // sk > :v
sk: { gte: "value" }              // sk >= :v
sk: { lt: "value" }               // sk < :v
sk: { lte: "value" }              // sk <= :v
sk: { between: ["a", "z"] }       // sk BETWEEN :v1 AND :v2

// Pagination and ordering
const recent = await table.query({
  pk: "USER#123",
  sk: { begins_with: "ORDER#" },
  limit: 10,
  scanIndexForward: false,  // newest first
});
```

### Dependencies

```typescript
import { users } from "./users.js";

export const orders = defineTable<Order>()
  .deps(() => ({ users }))
  .setup(({ deps }) => ({ users: deps.users }))
  .onRecord(async ({ record, users }) => {
    const userId = record.new?.data.userId;
    if (userId) {
      const user = await users.get({ pk: `USER#${userId}`, sk: "PROFILE" });
      console.log(`Order by ${user?.data.name}`);
    }
  });
```

### Resource-only (no Lambda)

```typescript
// Just creates the DynamoDB table — no stream, no Lambda
export const users = defineTable<User>().build();
```

**Built-in best practices**:
- **Single-table design** — fixed `pk`/`sk`/`tag`/`data`/`ttl` structure. Flexible access patterns via composite keys, no schema migrations needed.
- **Partial batch failures** — each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`. The rest of the batch succeeds.
- **Typed records** — pass the type as a generic (`defineTable<Order>()`) for type inference, or use a `schema` validation function for runtime checks. `schema` validates the `data` portion of stream records.
- **Table self-client** — `setup` receives a `table: TableClient<T>` for the handler's own table, auto-injected with no config.
- **Smart updates** — `update()` auto-prefixes `data.` for domain fields, so you can do partial updates without reading the full item.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for other tables with auto-wired IAM and env vars.
- **Auto-TTL** — TTL is always enabled on the `ttl` attribute. Set it on `put()` or `update()` and DynamoDB auto-deletes expired items.
- **Conditional writes** — use `{ ifNotExists: true }` on `put()` for idempotent inserts.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations.
- **Progressive complexity** — `.build()` for table-only. Add `.onRecord(...)` for stream processing. Add `.onRecordBatch(...)` for batch mode. Add `.deps(...)` for cross-table access.
- **Auto-infrastructure** — DynamoDB table, stream, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

---

## defineApp

Creates: CloudFront distribution + Lambda Function URL + S3 bucket for deploying SSR frameworks.

`defineApp` is a **curried factory**: call `defineApp()` (no args) to get the config function, then pass your options. This matches `defineMailer` and keeps the deploy-time extraction consistent.

```typescript
import { defineApp } from "effortless-aws";

export const app = defineApp()({
  // Required
  server: ".output/server",     // directory with Lambda server handler
  assets: ".output/public",     // directory with static assets for S3

  // Optional
  path: "/",                    // base URL path (default: "/")
  build: "nuxt build",          // shell command to run before deploy
  domain: "app.example.com",    // string, or stage-keyed record
  routes: { "/api/*": api },    // CloudFront overrides forwarded to a defineApi handler
  lambda: { memory: 1024, timeout: "30s" },
});
```

### Options

| Option | Type | Description |
|---|---|---|
| `server` | `string` | Directory containing the Lambda server handler (`index.mjs`/`index.js` exporting `handler`). |
| `assets` | `string` | Directory containing static assets for S3. |
| `path` | `string?` | Base URL path. Default: `"/"`. |
| `build` | `string?` | Shell command to run before deploy (e.g. `"nuxt build"`). |
| `domain` | `string \| Record<string, string>` | Custom domain (string, or stage-keyed record like `{ prod: "app.example.com" }`). |
| `routes` | `Record<string, Handler>` | CloudFront path overrides forwarded to API Gateway / another handler. |
| `lambda` | `{ memory?, timeout?, permissions?, logLevel? }` | Lambda function settings. |

The `server` directory must contain an `index.mjs` (or `index.js`) that exports a `handler` function — this is the standard output of frameworks like Nuxt (`NITRO_PRESET=aws-lambda`) and Astro SSR.

Static assets from `assets` are uploaded to S3 and served via CloudFront with `CachingOptimized`. All other requests go to the Lambda Function URL with `CachingDisabled`.

```typescript
export const app = defineApp()({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  domain: "app.example.com",
});
```

**Built-in best practices**:
- **Lambda Function URL** — no API Gateway overhead (~20-50ms latency saved), secured with AWS_IAM + CloudFront OAC.
- **Auto-detected cache behaviors** — static asset patterns (directories and files in `assets`) are auto-detected and routed to S3 with immutable caching.
- **CloudFront CDN** — global edge distribution for both static assets and SSR responses.
- **Custom domain** — string or stage-keyed record (`{ prod: "app.example.com" }`). ACM certificate in us-east-1 is auto-discovered.
- **Auto-infrastructure** — Lambda, Function URL, S3 bucket, CloudFront distribution, OAC, IAM role, and bucket policy are all created on deploy.

For static-only sites (no SSR), use [defineStaticSite](#definestaticsite) instead.

---

## defineStaticSite

Creates: S3 bucket + CloudFront distribution + Origin Access Control + CloudFront Function (viewer request) + optional Lambda@Edge (middleware).

`defineStaticSite` is a builder — chain `.route(...)`, `.middleware(...)`, then `.build()` to finalize.

```typescript
export const docs = defineStaticSite({
  // Required
  dir: "dist",                 // directory with built site files

  // Optional
  index: "index.html",         // default file (default: "index.html")
  build: "npx astro build",    // shell command to run before deploy
  errorPage: "404.html",       // relative to `dir`; set to same value as `index` to enable SPA mode
  domain: "example.com",       // custom domain (string or stage-keyed record)
  seo: {
    sitemap: "sitemap.xml",
    googleIndexing: "~/google-service-account.json",
  },
})
  .route("/api/*", api)        // CloudFront cache behavior proxied to a defineApi handler
  .middleware(async (req) => { /* ... */ })
  .build();
```

Files are synced to S3 and served via CloudFront globally. Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) are applied automatically via the AWS managed SecurityHeadersPolicy.

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  build: "npx astro build",
}).build();
```

### SPA mode

There's no `spa: true` flag. **SPA mode is enabled by setting `errorPage` to the same file as `index`** — any path that doesn't match a real file is served with `index.html` (HTTP 200), letting the client-side router handle it.

```typescript
export const dashboard = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  errorPage: "index.html",   // SPA mode: missing paths fall back to index.html
}).build();
```

If `errorPage` is set to a different file (e.g. `"404.html"`), that file is served with HTTP 404 for missing paths. If `errorPage` is omitted, a default 404 page is auto-generated.

### Custom domain

Set `domain` to serve your site on a custom domain instead of the default `*.cloudfront.net` URL:

```typescript
export const site = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  domain: "example.com",
}).build();
```

When `domain` is set, Effortless:
1. Finds an existing ACM certificate in **us-east-1** that covers your domain
2. Configures the CloudFront distribution with your domain as an alias and the SSL certificate
3. If the certificate also covers `www.example.com` (exact or wildcard `*.example.com`) — automatically adds `www` as a second alias and sets up a **301 redirect** from `www.example.com` → `example.com` via a CloudFront Function
4. If the certificate does **not** cover `www` — deploys without `www` and prints a warning

:::note[Prerequisites]
Before using `domain`, create an ACM certificate in the **us-east-1** region that covers your domain. For automatic www→non-www redirect, include `www.example.com` (or `*.example.com`) in the certificate. Then point your DNS to the CloudFront distribution domain name (CNAME or alias record).
:::

:::tip[SEO: www redirect]
Having both `example.com` and `www.example.com` serve the same content creates duplicate content issues for search engines. Effortless handles this automatically — when your ACM certificate covers `www`, a 301 redirect is set up so search engines index only the non-www version.
:::

### `.middleware(fn)` — Lambda@Edge

Add `.middleware(...)` to run custom Node.js code before CloudFront serves any page. Use it for authentication, access control, or redirects.

```typescript
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
})
  .middleware(async (request) => {
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }
    // return void → serve the page normally
  })
  .build();
```

The middleware function receives a simplified request object:

| Field | Type | Description |
|-------|------|-------------|
| `uri` | `string` | Request path (e.g. `/admin/users`) |
| `method` | `string` | HTTP method (`GET`, `POST`, etc.) |
| `querystring` | `string` | Raw query string |
| `headers` | `Record<string, string>` | Flattened request headers |
| `cookies` | `Record<string, string>` | Parsed cookies |

Return values control what happens next:

| Return | Effect |
|--------|--------|
| `void` / `undefined` | Continue serving — the static file is returned normally |
| `{ redirect: string, status?: 301 \| 302 \| 307 \| 308 }` | Redirect to another URL (default: 302) |
| `{ status: 403, body?: string }` | Block access with a 403 Forbidden response |

When middleware is present, it replaces the default CloudFront Function — the middleware handles both your custom logic **and** URL rewriting (`/path/` → `/path/index.html`) automatically.

:::note[Lambda@Edge constraints]
Middleware runs as Lambda@Edge on the `viewer-request` event. It has full Node.js runtime access (JWT validation, crypto, network calls), but with some constraints: deployed to **us-east-1** only (CloudFront replicates globally), **no environment variables** (so `deps` and `config` are not available), **x86_64** architecture, 128 MB memory, and 5-second timeout.
:::

:::tip[Separate domains for public and protected content]
Each `defineStaticSite` creates its own CloudFront distribution, so you can use different configurations for public and protected content:

```typescript
// Public landing — no middleware, just CDN
export const landing = defineStaticSite({
  dir: "landing/dist",
  domain: "example.com",
}).build();

// Protected admin — with auth middleware
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
})
  .middleware(async (request) => {
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }
  })
  .build();
```
:::

### `.route(pattern, origin, opts?)` — API proxy

Forward specific URL patterns to your `defineApi` handler instead of S3. This eliminates CORS by serving frontend and API from the same domain.

```typescript
import { api } from "./api";

export const app = defineStaticSite({
  dir: "dist",
  errorPage: "index.html",   // SPA mode
  domain: "example.com",
})
  .route("/api/*", api)
  .build();
```

The `origin` is a reference to a `defineApi` handler. Effortless resolves the Function URL domain at deploy time and creates CloudFront cache behaviors for each pattern — with caching disabled, all HTTP methods allowed, and all headers forwarded.

### Error pages

For non-SPA sites, Effortless generates a clean, minimal 404 page automatically. Both 403 (S3 access denied for missing files) and 404 are served with this page and a proper 404 HTTP status.

To use your own error page instead, set `errorPage` to a path relative to `dir`:

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  errorPage: "404.html",
}).build();
```

For SPA sites (`errorPage` === `index`), error pages are not used — all paths route to `index.html`.

### SEO — sitemap, robots.txt, Google Indexing

Add `seo` to auto-generate `sitemap.xml` and `robots.txt` at deploy time, and optionally submit pages to the Google Indexing API for faster crawling.

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  domain: "example.com",
  seo: { sitemap: "sitemap.xml" },
}).build();
```

On every deploy, Effortless:
1. Walks the `dir` directory and collects all `.html` files
2. Generates a sitemap XML with `<loc>` entries for each page (skips `404.html` and `500.html`)
3. Generates `robots.txt` with `Allow: /` and a `Sitemap:` directive pointing to your sitemap
4. Uploads both to S3 (sitemap is skipped if you already have one in `dir` — e.g. from Astro's sitemap plugin)

URL paths are normalized: `about/index.html` becomes `https://example.com/about/`, `page.html` stays as `https://example.com/page.html`.

#### Google Indexing API

Google can take days or weeks to discover new pages. The [Indexing API](https://developers.google.com/search/apis/indexing-api/v3/quickstart) lets you notify Google immediately when pages are published.

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  domain: "example.com",
  seo: {
    sitemap: "sitemap.xml",
    googleIndexing: "~/google-service-account.json",
  },
}).build();
```

On deploy, Effortless submits all page URLs via the Indexing API. Already-submitted URLs are tracked in S3 and skipped on subsequent deploys — only new pages are submitted.

**Setup:**
1. Create a [Google Cloud service account](https://console.cloud.google.com/iam-admin/serviceaccounts) and download the JSON key
2. In [Google Search Console](https://search.google.com/search-console), add the service account email as an **Owner** (Settings → Users and permissions)
3. Set `googleIndexing` to the path of your JSON key file (relative to project root, or `~/` for home directory)

:::note[Google Indexing API quota]
Google allows up to 200 URL notifications per day. If your site has more than 200 pages, Effortless submits the first 200 and picks up the rest on the next deploy.
:::

**Built-in best practices**:
- **URL rewriting** — automatically resolves `/path/` to `/path/index.html` via CloudFront Function.
- **SPA support** — when `errorPage === index`, missing paths return `index.html` with HTTP 200 for client-side routing.
- **Security headers** — HSTS, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy are applied automatically to all responses.
- **Error pages** — non-SPA sites get a clean 404 page out of the box (overridable via `errorPage`).
- **API route proxying** — use `.route(pattern, api)` to forward path patterns to a `defineApi` handler, eliminating CORS for same-domain frontend + API setups.
- **Global distribution** — served via CloudFront edge locations worldwide.
- **Custom domains** — set `domain` for a custom domain with automatic ACM certificate lookup and optional www→non-www redirect.
- **Edge middleware** — add `.middleware(...)` for auth checks, redirects, or access control via Lambda@Edge. Full Node.js runtime at the edge — JWT validation, cookie checks, custom logic.
- **SEO automation** — auto-generate `sitemap.xml` and `robots.txt` at deploy time, submit new pages to Google Indexing API.
- **Orphan cleanup** — when CloudFront Functions become unused (e.g. after config changes), they are automatically deleted on the next deploy.
- **Auto-infrastructure** — S3 bucket, CloudFront distribution, Origin Access Control, CloudFront Function (or Lambda@Edge), cache invalidation, and SSL certificate configuration on deploy.

---

## defineQueue

Creates: SQS Queue (FIFO) + Lambda + Event Source Mapping + IAM permissions

### Options

| Option | Type | Description |
|---|---|---|
| `fifo` | `boolean` | Enable FIFO semantics. Currently only `true` is supported. |
| `visibilityTimeout` | `Duration?` | Default: max of Lambda timeout or `"30s"`. |
| `retentionPeriod` | `Duration?` | Default: `"4d"`. |
| `delay` | `Duration?` | Delivery delay for all messages. Default: `0`. |
| `contentBasedDeduplication` | `boolean?` | FIFO only. Default: `true`. |
| `maxReceiveCount` | `number?` | Receives before moving to DLQ. Default: `3`. |
| `schema` | `(input: unknown) => T` | Validate & parse message body. |

### Builder chain

```typescript
export const orderQueue = defineQueue<OrderEvent>({ fifo: true })
  .deps(() => ({ ... }))
  .config(({ defineSecret }) => ({ ... }))
  .include("glob")
  .poller({ batchSize: 5, batchWindow: "2s" })        // event source mapping
  .setup(({ deps, config }) => C, { memory: 512, timeout: "1m" })
  .onError(({ error }) => { /* ... */ })
  .onCleanup(() => { /* ... */ })
  // Terminal — pick one:
  .onMessage(async ({ message, ...ctx }) => { /* ... */ });
  // .onMessageBatch(async ({ messages, ...ctx }) => { /* ... */ });
  // .build();   // resource-only
```

### `.poller(opts)` — event source mapping

| Option | Type | Description |
|---|---|---|
| `batchSize` | `number?` | 1–10 for FIFO. Default: 10. |
| `batchWindow` | `Duration?` | Max time to gather messages before invoking. Default: 0. |

### Callback arguments

All queue callbacks (`onMessage`, `onMessageBatch`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `message` / `messages` | `QueueMessage<T>` / `QueueMessage<T>[]` | Parsed messages with typed `body`. |
| `...ctx` | spread | All properties from setup return, spread directly. |

`deps` and `config` are available in `.setup()` only — wire them into the setup return to use in callbacks.

The `QueueMessage<T>` object:

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | `string` | Unique message identifier |
| `body` | `T` | Parsed body (JSON-decoded, then optionally schema-validated) |
| `rawBody` | `string` | Raw unparsed message body string |
| `messageGroupId` | `string` | FIFO ordering key |
| `messageDeduplicationId` | `string?` | Deduplication ID |
| `receiptHandle` | `string` | Receipt handle for acknowledgement |
| `messageAttributes` | `Record<string, ...>` | SQS message attributes |

### Per-message processing

```typescript
type OrderEvent = { orderId: string; action: string };

export const orderQueue = defineQueue<OrderEvent>({ fifo: true })
  .onMessage(async ({ message }) => {
    console.log(`Order ${message.body.orderId}: ${message.body.action}`);
    await processOrder(message.body);
  });
```

Each message is processed individually. If one fails, only that message is retried via `batchItemFailures`. The rest of the batch succeeds.

### Batch processing

```typescript
export const notifications = defineQueue<Notification>({ fifo: true })
  .poller({ batchSize: 5 })
  .onMessageBatch(async ({ messages }) => {
    await sendAll(messages.map((m) => m.body));
  });
```

All messages in a batch are processed together. If the handler throws, all messages are reported as failed. Return `{ failures: string[] }` with messageIds for partial batch failure reporting.

### Schema validation

```typescript
export const events = defineQueue({
  fifo: true,
  schema: (input) => {
    const obj = input as any;
    if (!obj?.eventType) throw new Error("eventType is required");
    return { eventType: obj.eventType as string, payload: obj.payload };
  },
})
  .onMessage(async ({ message }) => {
    // message.body is typed: { eventType: string; payload: unknown }
  });
```

When `schema` throws, the message is reported as a batch item failure automatically.

### Dependencies

```typescript
import { orders } from "./orders.js";

export const orderProcessor = defineQueue<OrderEvent>({ fifo: true })
  .deps(() => ({ orders }))
  .setup(({ deps }) => ({ orders: deps.orders }))
  .onMessage(async ({ message, orders }) => {
    // orders is TableClient<Order>
    await orders.put({
      pk: `ORDER#${message.body.orderId}`, sk: "STATUS",
      data: { tag: "order", status: "processing" },
    });
  });
```

Dependencies are auto-wired: the framework sets environment variables, IAM permissions, and provides typed `TableClient` instances at runtime.

**Built-in best practices**:
- **Partial batch failures** — each message is processed individually (`onMessage` mode). If one fails, only that message is retried via `batchItemFailures`. The rest of the batch succeeds.
- **FIFO ordering** — messages within the same `messageGroupId` are delivered in order. Use message groups to partition work while maintaining ordering guarantees.
- **Content-based deduplication** — enabled by default. SQS uses the message body hash to prevent duplicates within the 5-minute deduplication interval.
- **Typed messages** — pass the type as a generic (`defineQueue<OrderEvent>({ fifo: true })`) or use a `schema` validation function for typed `message.body` with automatic JSON parsing.
- **Schema validation** — when `schema` is set, each message body is validated before your handler runs. Invalid messages are automatically reported as failures.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for DynamoDB tables with auto-wired IAM and env vars.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations.
- **Auto-infrastructure** — SQS FIFO queue, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

---

## defineCron

Creates: EventBridge Scheduler + Lambda + IAM permissions

```typescript
export const cleanup = defineCron({ schedule: "rate(2 hours)" })
  .onTick(async () => {
    console.log("running cleanup");
  });
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `schedule` | `ScheduleExpression` | **Required.** `"rate(5 minutes)"`, `"rate(1 hour)"`, `"cron(0 9 * * ? *)"` |
| `timezone` | `Timezone` | IANA timezone (default: UTC). Full autocomplete for 418 zones. |

### Builder chain

| Method | Description |
|--------|-------------|
| `.deps(() => ({ ... }))` | Declare dependencies (tables, queues, buckets, mailers) |
| `.config(({ defineSecret }) => ({ ... }))` | Declare SSM secrets |
| `.include("glob")` | Include static files in Lambda bundle. Chainable. |
| `.setup({ memory, timeout, ... })` | Configure Lambda settings only |
| `.setup(async ({ deps, config, files }) => ({ ... }))` | Cold-start init |
| `.setup(fn, { memory, timeout, ... })` | Cold-start init + Lambda settings |
| `.onError(({ error }) => { ... })` | Error handler for onTick failures |
| `.onCleanup(async () => { ... })` | Runs after each invocation |
| `.onTick(async (ctx) => { ... })` | **Terminal.** Called on each scheduled invocation |

### Full example

```typescript
import { defineCron } from "effortless-aws";
import { orders } from "./orders.js";

export const sync = defineCron({
  schedule: "cron(0 18 ? * MON-FRI *)",
  timezone: "Europe/Moscow",
})
  .deps(() => ({ orders }))
  .config(({ defineSecret }) => ({ apiKey: defineSecret() }))
  .include("templates/*.html")
  .setup(async ({ deps, config, files }) => ({
    db: deps.orders,
    key: config.apiKey,
    tpl: files,
  }), { memory: 512, timeout: "5m" })
  .onError(({ error }) => console.error("sync failed", error))
  .onTick(async ({ db, key, tpl }) => {
    const html = tpl.read("templates/report.html");
    const expired = await db.query({ pk: "ORDER", sk: { lt: cutoff } });
    // process expired orders...
  });
```

### Schedule expressions

**Rate** — run at fixed intervals (strictly typed units):
```
"rate(5 minutes)"
"rate(1 hour)"
"rate(1 day)"
```

**Cron** — run at specific times (6 fields: min hour dom month dow year):
```
"cron(0 9 * * ? *)"          // daily at 9:00 UTC
"cron(0 9 ? * MON-FRI *)"    // weekdays at 9:00
"cron(0/15 * * * ? *)"       // every 15 minutes
```

### Timezone

Pass any IANA timezone — EventBridge Scheduler handles DST transitions automatically:

```typescript
defineCron({
  schedule: "cron(0 9 * * ? *)",
  timezone: "America/New_York",  // 9:00 EST in winter, 9:00 EDT in summer
})
```

**Built-in best practices**:
- **Auto-infrastructure** — EventBridge Scheduler, Lambda, and IAM permissions are all created on deploy from this single definition.
- **Typed rate expressions** — `rate()` units (`minute`, `hours`, `day`, etc.) are validated at compile time.
- **418 IANA timezones** — full autocomplete, DST-aware. Generated from `Intl.supportedValuesOf("timeZone")`.
- **Cold start optimization** — `setup` runs once and is cached across invocations.
- **Same builder pattern** — `.deps()`, `.config()`, `.include()`, `.setup()` work identically across all handler types.

---

## defineBucket

Creates: S3 Bucket + (optional) Lambda + S3 Event Notifications

Like `defineTable`, `defineBucket` supports **resource-only** mode — finish the chain with `.build()` to create just the bucket, referenceable via `deps` from other handlers.

### Options

| Option | Type | Description |
|---|---|---|
| `prefix` | `string?` | S3 key prefix filter for event notifications (e.g. `"images/"`). |
| `suffix` | `string?` | S3 key suffix filter (e.g. `".jpg"`). |
| `seed` | `string?` | Local directory to seed into the bucket on first deploy. |
| `sync` | `string?` | Local directory to sync on every deploy (uploads new, deletes removed). |

### Builder chain

```typescript
export const uploads = defineBucket({ prefix: "images/", suffix: ".jpg" })
  .deps(() => ({ ... }))
  .config(({ defineSecret }) => ({ ... }))
  .include("glob")
  .entity<User>("users", { cache: "5m" })        // typed JSON entity: users/{id}.json
  .setup(({ bucket, deps, config, files }) => C, { memory: 512 })
  .onError(({ error }) => { /* ... */ })
  .onCleanup(() => { /* ... */ })
  // Terminal — pick ONE of:
  .onObjectCreated(async ({ event, bucket, ...ctx }) => { /* ... */ });
  // .onObjectRemoved(async ({ event, bucket, ...ctx }) => { /* ... */ });
  // .build();   // resource-only, no Lambda
```

:::note[One terminal per bucket]
A single `defineBucket` can have **either** `.onObjectCreated(...)` **or** `.onObjectRemoved(...)` — not both. If you need to react to both events, define two buckets (typically with the same resource via `deps`), or define one bucket and a second handler that reacts to the other event.
:::

### BucketEvent

Event callbacks receive a `BucketEvent`:

| Field | Type | Description |
|-------|------|-------------|
| `eventName` | `string` | S3 event name (e.g. `"ObjectCreated:Put"`, `"ObjectRemoved:Delete"`) |
| `key` | `string` | Object key (path within the bucket) |
| `size` | `number?` | Object size in bytes (present for created events) |
| `eTag` | `string?` | Object ETag (present for created events) |
| `eventTime` | `string?` | ISO 8601 timestamp of the event |
| `bucketName` | `string` | S3 bucket name |

### Callback arguments

All event callbacks (`onObjectCreated`, `onObjectRemoved`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `event` | `BucketEvent` | S3 event record |
| `...ctx` | spread | All properties from setup return, spread directly |

`deps` and `config` are available in `.setup()` only — wire them into the setup return to use in callbacks. The bucket self-client is available inside `.setup()` as `args.bucket`.

### BucketClient

The self-client is injected into `.setup()` as `bucket`. Other handlers get it via `deps`.

```typescript
BucketClient
  put(key: string, body: Buffer | string, options?: { contentType?: string }): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType?: string } | undefined>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<{ key: string; size: number; lastModified?: Date }[]>
  bucketName: string
```

**put** — upload an object:

```typescript
await bucket.put("images/photo.jpg", imageBuffer, { contentType: "image/jpeg" });
await bucket.put("data/config.json", JSON.stringify(config));
```

**get** — download an object. Returns `undefined` if not found:

```typescript
const file = await bucket.get("images/photo.jpg");
if (file) {
  console.log(file.body.length, file.contentType);
}
```

**delete** — remove an object:

```typescript
await bucket.delete("images/old-photo.jpg");
```

**list** — list objects, optionally filtered by prefix:

```typescript
const all = await bucket.list();
const images = await bucket.list("images/");
// [{ key: "images/a.jpg", size: 1024, lastModified: Date }, ...]
```

### Event handlers

```typescript
export const uploads = defineBucket({ prefix: "images/", suffix: ".jpg" })
  .setup(({ bucket }) => ({ bucket }))
  .onObjectCreated(async ({ event, bucket }) => {
    const file = await bucket.get(event.key);
    console.log(`New image: ${event.key}, size: ${file?.body.length}`);
  });
```

### Dependencies

```typescript
import { orders } from "./orders.js";

export const invoices = defineBucket({ prefix: "invoices/" })
  .deps(() => ({ orders }))
  .setup(({ deps }) => ({ orders: deps.orders }))
  .onObjectCreated(async ({ event, orders }) => {
    // orders is TableClient<Order>
    await orders.put({
      pk: "INVOICE#1", sk: "FILE",
      data: { tag: "invoice", key: event.key, size: event.size ?? 0 },
    });
  });
```

### Resource-only (no Lambda)

```typescript
// Just creates the S3 bucket — no event notifications, no Lambda
export const assets = defineBucket().build();
```

Use it as a dependency from other handlers:

```typescript
import { assets } from "./assets.js";

export const api = defineApi({ basePath: "/uploads" })
  .deps(() => ({ assets }))
  .setup(({ deps }) => ({ assets: deps.assets }))
  .post({ path: "/upload" }, async ({ req, assets, ok }) => {
    // assets is BucketClient
    await assets.put("uploads/file.txt", req.body);
    return ok({}, 201);
  });
```

**Built-in best practices**:
- **Filtered triggers** — use `prefix` and `suffix` to limit which S3 events invoke the Lambda, reducing unnecessary invocations.
- **Self-client** — `setup` receives a `bucket: BucketClient` for the handler's own bucket, auto-injected with no config.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` and `BucketClient` instances with auto-wired IAM and env vars.
- **Resource-only mode** — finish with `.build()` to create just the bucket. Reference it via `deps` from other handlers.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations. Receives `bucket` (self-client) alongside `deps` and `config`.
- **Error isolation** — each S3 event record is processed individually. If one fails, the error is logged and the remaining records continue processing.
- **Auto-infrastructure** — S3 bucket, Lambda, S3 event notifications, and IAM permissions are all created on deploy from this single definition.

---

## defineWorker

Creates: Fargate container + SQS queue + IAM permissions

A **long-running Fargate container** with an SQS queue. The worker stays alive while processing messages and shuts down after an idle timeout. Other handlers send messages to the worker via `deps.worker.send(msg)`.

### Options

| Option | Type | Description |
|---|---|---|
| `size` | `FargateSize?` | `"0.25vCPU-512mb"` → `"4vCPU-8gb"`. Default: `"0.5vCPU-1gb"`. |
| `idleTimeout` | `Duration?` | Shutdown after idle. Default: `"5m"`. |
| `concurrency` | `number?` | Max messages processed in parallel (1–10). Default: 1. |

### Builder chain

```typescript
type Job = { type: "export"; userId: string };

export const worker = defineWorker<Job>({ size: "1vCPU-2gb", concurrency: 5 })
  .deps(() => ({ orders }))
  .config(({ defineSecret }) => ({ apiKey: defineSecret() }))
  .include("glob")
  .setup(async ({ deps, config, files }) => ({ db: deps.orders, key: config.apiKey }))
  .onError(({ error, msg, retryCount }) => (retryCount > 3 ? "delete" : "retry"))
  .onCleanup(() => { /* flush */ })
  .onMessage(async (msg, { db, key }) => {
    await processJob(msg, db, key);
  });
```

`.onError` can return `"retry"` (default) or `"delete"` to control redelivery.

**Built-in best practices**:
- **Long-running** — stays alive as long as messages arrive, reusing connections, clients, and caches.
- **Auto-scale to zero** — shuts down after `idleTimeout` with no messages.
- **SQS-backed** — reliable delivery, visibility timeout, and retries. The queue is a first-class `deps` target.
- **Auto-infrastructure** — Fargate task definition + service, SQS queue, IAM role, and CloudWatch log group are all created on deploy.

---

## defineMailer

Creates: SES Email Identity (domain verification + DKIM)

`defineMailer` is a **resource-only, curried factory** — call `defineMailer()` to get the config function, then pass your options. It doesn't create a Lambda function; it sets up an SES email identity for a domain and provides a typed `EmailClient` to other handlers via `deps`.

```typescript
export const mailer = defineMailer()({ domain: "myapp.com" });
```

On first deploy, DKIM DNS records are printed to the console. Add them to your DNS provider to verify the domain. Subsequent deploys check verification status and skip if already verified.

### Using from other handlers

Import the mailer and add it to `deps`. The framework injects a typed `EmailClient` with SES send permissions auto-wired.

```typescript
import { defineApi } from "effortless-aws";
import { mailer } from "./mailer.js";

export const api = defineApi({ basePath: "/welcome" })
  .deps(() => ({ mailer }))
  .setup(({ deps }) => ({ mailer: deps.mailer }))
  .post({ path: "/send" }, async ({ req, mailer, ok }) => {
    await mailer.send({
      from: "hello@myapp.com",
      to: (req.body as { email: string }).email,
      subject: "Welcome!",
      html: "<h1>Welcome aboard!</h1>",
    });
    return ok({ sent: true });
  });
```

### EmailClient

The `EmailClient` injected via `deps` has a single method:

```typescript
EmailClient
  send(opts: SendEmailOptions): Promise<void>
```

**send** — send an email via SES. At least one of `html` or `text` is required.

```typescript
await deps.mailer.send({
  from: "hello@myapp.com",       // must be on a verified domain
  to: "user@example.com",        // string or string[]
  subject: "Hello!",
  html: "<h1>Hi!</h1>",          // HTML body
  text: "Hi!",                   // plain text fallback (optional when html is set)
});
```

Multiple recipients:

```typescript
await deps.mailer.send({
  from: "team@myapp.com",
  to: ["alice@example.com", "bob@example.com"],
  subject: "Team update",
  text: "New release is out!",
});
```

**Built-in best practices**:
- **Resource-only** — no Lambda is created. The mailer is purely an SES identity + typed client for `deps`.
- **DKIM verification** — on first deploy, RSA 2048-bit DKIM signing is configured automatically. DNS records are printed to the console.
- **Typed client** — `deps.mailer` is an `EmailClient` with a typed `send()` method. At least one of `html` or `text` is required at compile time.
- **Lazy SDK init** — the SES client is created on first `send()` call, not on cold start. Zero overhead if the email path is not hit.
- **Auto-IAM** — the dependent Lambda gets `ses:SendEmail` and `ses:SendRawEmail` permissions automatically.
- **Cleanup** — `eff cleanup` removes SES identities along with all other resources.

---

## defineMcp

Creates: Lambda + Function URL implementing the Model Context Protocol (Streamable HTTP).

`defineMcp` exposes **tools**, **resources**, and **prompts** to MCP-compatible clients (Claude, ChatGPT, Cursor, etc.). Each is registered individually via `.tool(def, handler)`, `.resource(def, handler)`, `.prompt(def, handler)` — all chainable and repeatable.

### Options

| Option | Type | Description |
|---|---|---|
| `name` | `string` | **Required.** Server name (used in server info). |
| `version` | `string?` | Default: `"1.0.0"`. |
| `instructions` | `string?` | Sent to clients in `initialize` as system prompt context. |

### Builder chain

```typescript
export const mcp = defineMcp({ name: "crm", instructions: "Contacts CRM." })
  .deps(() => ({ contacts }))
  .config(({ defineSecret }) => ({ token: defineSecret({ generate: "hex:32" }) }))
  .include("glob")
  .auth<{ role: string }>(({ config }) => ({
    secret: config.token,
    apiToken: { verify: (t) => (t === config.token ? { role: "client" } : null) },
  }))
  .setup(({ deps }) => ({ db: deps.contacts }), { memory: 512 })
  .tool({ name: "say_hello", description: "...", input: { /* JSON Schema */ } }, async (input) => ({
    content: [{ type: "text", text: `Hello, ${input.name}!` }],
  }))
  .resource({ uri: "resource://contacts/{id}", name: "Contact" }, async (params, { db }) => {
    const item = await db.get({ pk: params.id, sk: "profile" });
    return { uri: `resource://contacts/${params.id}`, text: JSON.stringify(item?.data) };
  })
  .prompt({ name: "outreach", arguments: [{ name: "contactId", required: true }] }, async (args, { db }) => {
    const item = await db.get({ pk: args.contactId, sk: "profile" });
    return `Draft a short outreach email for:\n${JSON.stringify(item?.data)}`;
  });
```

### `.tool(def, handler)`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Tool name. |
| `description` | `string` | What the tool does (model reads this). |
| `input` | `StandardJSONSchemaV1 \| McpInputSchema` | Input schema (Zod `z.object(...)` or raw JSON Schema). |

Handler returns `McpToolResult`: `{ content: McpToolContent[], isError?: boolean }`.

### `.resource(def, handler)`

| Field | Type | Description |
|---|---|---|
| `uri` | `string` | Resource URI or URI template (e.g. `"resource://contacts/{id}"`). |
| `name` | `string` | Human-readable name. |
| `description` | `string?` | Optional description. |
| `mimeType` | `string?` | Optional MIME type. |
| `params` | `StandardSchemaV1?` | Validator for URI template params (typed `params` in handler). |

Handler returns `McpResourceContent` (single) or `McpResourceContent[]`. Plain data is auto-wrapped.

### `.prompt(def, handler)`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Prompt name. |
| `description` | `string?` | Human-readable description. |
| `args` | `StandardSchemaV1 \| McpPromptArgument[] \| undefined` | Args schema (typed) or untyped list. |

Handler returns a `string` (auto-wrapped as a user message) or a full `McpPromptResult`.

**Built-in best practices**:
- **Streamable HTTP transport** — JSON-RPC over HTTP POST, per the MCP 2025-03-26 spec.
- **Singular registration** — `.tool(...)`, `.resource(...)`, `.prompt(...)` can be called in any order, any number of times, all chainable.
- **Typed schemas** — Standard Schema (Zod, Valibot, Arktype) for inputs, resource params, and prompt args. Falls back to raw JSON Schema for tools.
- **Auth** — `.auth(fn)` with Bearer token (`apiToken`) or session cookie, same pattern as `defineApi`.
- **Auto-infrastructure** — Lambda, Function URL, IAM role on deploy.
