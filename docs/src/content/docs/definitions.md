---
title: Definitions
description: All definition types — defineHttp, defineTable, defineApp, defineStaticSite, defineFifoQueue, defineBucket, defineSchedule, defineEvent.
---

## Overview

Every resource in Effortless is created with a `define*` function. Each call declares **what** you need — the framework handles the infrastructure.

Some definitions include a Lambda handler (a callback like `onRequest`, `onRecord`, or `onMessage`). Others are **resource-only** — they create AWS resources without any code attached:

| Definition | Creates | Handler required? |
|---|---|---|
| [defineHttp](#definehttp) | API Gateway + Lambda | Yes (`onRequest`) |
| [defineTable](#definetable) | DynamoDB table + optional stream Lambda | No — table-only when no `onRecord`/`onBatch` |
| [defineApp](#defineapp) | API Gateway + Lambda serving static files | No (built-in file server) |
| [defineStaticSite](#definestaticsite) | S3 + CloudFront + optional Lambda@Edge | No (optional `middleware`) |
| [defineFifoQueue](#definefifoqueue) | SQS FIFO + Lambda | Yes (`onMessage`/`onBatch`) |
| [defineSchedule](#defineschedule) | EventBridge + Lambda | Yes — Planned |
| [defineEvent](#defineevent) | EventBridge + Lambda | Yes — Planned |
| [defineBucket](#definebucket) | S3 bucket + optional event Lambda | No — resource-only when no `onObjectCreated`/`onObjectRemoved` |

Resource-only definitions are useful when you need the infrastructure but handle it from elsewhere. For example, a `defineTable` without stream callbacks creates a DynamoDB table, and a `defineBucket` without event callbacks creates an S3 bucket — both referenceable via `deps`:

```typescript
// Just a table — no Lambda, no stream
export const users = defineTable({
  schema: typed<User>(),
});

// Just a bucket — no Lambda, no event notifications
export const uploads = defineBucket({});

// HTTP endpoint that writes to the table and bucket
export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  deps: { users, uploads },
  onRequest: async ({ req, deps }) => {
    await deps.users.put({
      pk: "USER#1", sk: "PROFILE",
      data: { tag: "user", name: "Alice", email: "alice@example.com" },
    });
    await deps.uploads.put("avatars/user-1.png", avatarBuffer);
    return { status: 201 };
  },
});
```

---

## Type inference

Every handler function (`defineHttp`, `defineTable`, `defineFifoQueue`) uses TypeScript generics internally to connect types across `schema`, `setup`, `deps`, `config`, and callbacks. You don't need to specify these generics yourself — TypeScript infers them automatically from the options you pass.

Use `schema` to provide the data type. For type-only schemas (no runtime validation), use the `typed<T>()` helper:

```typescript
import { defineTable, defineHttp, defineFifoQueue, typed, param } from "effortless-aws";

type Order = { tag: string; amount: number; status: string };

export const orders = defineTable({
  schema: typed<Order>(),            // T = Order — inferred from schema
  config: {
    threshold: param("threshold", Number),
  },
  setup: async ({ config }) => ({    // C = { db: Pool } — inferred from return type
    db: createPool(config.threshold),
  }),
  deps: { users },                   // D — inferred from deps object
  onRecord: async ({ record, ctx, deps, config }) => {
    // record.new?.data is Order | undefined
    // ctx is { db: Pool }
    // deps.users is TableClient<User>
    // config.threshold is number
    // Everything is typed — no manual generics needed
  },
});
```

:::caution[Avoid explicit generics]
Don't write `defineTable<Order>(...)` or `defineFifoQueue<Event>(...)`. When you specify even one generic parameter explicitly, TypeScript stops inferring the rest — `setup`, `deps`, and `config` lose their types. Always use `schema` instead.
:::

For runtime validation (e.g., stream records or message bodies), pass a real validation function:

```typescript
export const payments = defineFifoQueue({
  schema: (input: unknown) => {
    const obj = input as Record<string, unknown>;
    if (typeof obj?.paymentId !== "string") throw new Error("paymentId required");
    if (typeof obj?.amount !== "number") throw new Error("amount required");
    return { paymentId: obj.paymentId, amount: obj.amount };
  },
  // T inferred as { paymentId: string; amount: number }
  onMessage: async ({ message }) => {
    // message.body is validated at runtime AND typed at compile time
  },
});
```

---

## Shared options

These options are available on all Lambda-backed handlers (`defineHttp`, `defineTable`, `defineFifoQueue`).

### `schema`

Decode/validate function for incoming data (request body, stream record, or queue message). When provided, the handler receives a typed `data` / `record` / `message.body`. If the function throws, the framework returns an error automatically (400 for HTTP, batch item failure for streams/queues).

```typescript
schema: (input: unknown) => {
  const obj = input as any;
  if (!obj?.name) throw new Error("name required");
  return { name: obj.name as string };
},
```

For type-only inference (no runtime validation), use the `typed<T>()` helper:

```typescript
schema: typed<Order>(),
```

### `setup`

Factory function called once on cold start. The return value is cached and passed as `ctx` to every invocation. Supports async. When `deps` or `config` are declared, receives them as argument.

```typescript
// No deps/config — zero-arg
setup: () => ({ pool: createPool() }),

// With deps and/or config
setup: async ({ deps, config }) => ({
  pool: createPool(config.dbUrl),
}),
```

### `deps`

Dependencies on other handlers (tables and buckets). The framework auto-wires environment variables, IAM permissions, and injects typed clients at runtime — `TableClient<T>` for tables, `BucketClient` for buckets.

```typescript
import { orders } from "./orders.js";
import { uploads } from "./uploads.js";

deps: { orders, uploads },
// → deps.orders is TableClient<Order>
// → deps.uploads is BucketClient
```

### `config`

SSM Parameter Store values. Declare with `param()` for transforms, or plain strings for simple keys. Values are fetched once on cold start and cached.

```typescript
import { param } from "effortless-aws";

config: {
  dbUrl: "database-url",                    // plain string → string value
  appConfig: param("app-config", JSON.parse), // param() with transform → parsed type
},
// → config.dbUrl is string
// → config.appConfig is ReturnType<typeof JSON.parse>
```

SSM path is built automatically: `/${project}/${stage}/${key}`.

### `static`

Glob patterns for files to bundle into the Lambda ZIP. At runtime, read them via the `files` callback argument.

```typescript
static: ["src/templates/*.ejs"],
// → files.read("src/templates/invoice.ejs") returns file contents as string
```

### `permissions`

Additional IAM permissions for the Lambda execution role. Format: `"service:Action"`.

```typescript
permissions: ["s3:PutObject", "ses:SendEmail"],
```

### `logLevel`

Logging verbosity: `"error"` (errors only), `"info"` (+ execution summary), `"debug"` (+ truncated input/output). Default: `"info"`.

---

## defineHttp

Creates: API Gateway HTTP API + Lambda + Route

```typescript
export const api = defineHttp({
  // Required
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,  // e.g. "/api/users/{id}"

  // Optional
  memory?: number,
  timeout?: DurationInput,
  permissions?: Permission[],         // additional IAM permissions (e.g. ["s3:PutObject"])
  schema?: (input: unknown) => T,     // validate & parse request body
  setup?: ({ deps, config }) => C,    // factory for shared state (cached on cold start)
  deps?: { [key]: TableHandler },     // inter-handler dependencies
  config?: { [key]: param(...) },     // SSM parameters

  onRequest: async ({ req, ctx, data, deps, config }) => {
    // req.method, req.path, req.headers, req.query, req.params, req.body
    // ctx — setup result (when setup is set)
    // data — parsed body (when schema is set)
    // deps — typed table clients (when deps is set)
    // config — SSM parameter values (when config is set)
    return {
      status: 200,
      body: { data: "response" },
      headers?: { ... },
    };
  }
});
```

### Schema validation

```typescript
export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  schema: (input) => {
    const obj = input as any;
    if (!obj?.name) throw new Error("name is required");
    return { name: obj.name as string };
  },
  onRequest: async ({ data }) => {
    // data is { name: string } — typed from schema return type
    return { status: 201, body: { created: data.name } };
  }
});
```

When `schema` throws, the framework returns a 400 response automatically with the error message.

### Dependencies

```typescript
import { orders } from "./orders.js";

export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ req, deps }) => {
    // deps.orders is TableClient<Order> — typed from the table's generic
    await deps.orders.put({
      pk: "USER#123", sk: "ORDER#456",
      data: { tag: "order", amount: 99, status: "pending" },
    });
    return { status: 201 };
  }
});
```

Dependencies are auto-wired: the framework sets environment variables, IAM permissions, and provides typed `TableClient` instances at runtime. See [architecture](./architecture#inter-handler-dependencies-deps) for details.

**Built-in best practices**:
- **Cold start optimization** — the `setup` factory runs once on cold start and is cached across invocations. Use it for DB connections, SDK clients, config loading.
- **Schema validation** — when `schema` is set, the body is parsed and validated before `onRequest` runs. Invalid requests get a 400 response automatically.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances with auto-wired IAM permissions and environment variables.
- **Auto-infrastructure** — API Gateway HTTP API, route, Lambda integration, and IAM permissions are created on deploy.

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

```typescript
export const orders = defineTable({
  // Optional — type inference
  schema?: (input: unknown) => T,     // infers record type T (or use typed<T>())

  // Optional — table
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED",  // default: PAY_PER_REQUEST
  tagField?: string,                  // field in data for entity discriminant (default: "tag")

  // Optional — stream
  streamView?: "NEW_AND_OLD_IMAGES" | "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY",  // default: NEW_AND_OLD_IMAGES
  batchSize?: number,                // 1-10000, default: 100
  startingPosition?: "LATEST" | "TRIM_HORIZON",  // default: LATEST

  // Optional — lambda
  memory?: number,
  timeout?: DurationInput,
  permissions?: Permission[],         // additional IAM permissions
  setup?: ({ deps, config }) => C,    // factory for shared state (cached on cold start)
  deps?: { [key]: TableHandler },     // inter-handler dependencies
  config?: { [key]: param(...) },     // SSM parameters

  // Stream handler — choose one mode:

  // Mode 1: per-record processing
  onRecord: async ({ record, table, ctx, deps, config }) => { ... },
  onBatchComplete?: async ({ results, failures, table, ctx, deps, config }) => { ... },

  // Mode 2: batch processing
  onBatch: async ({ records, table, ctx, deps, config }) => { ... },
});
```

Use `schema` or `typed<T>()` to provide the data type. `T` is the domain data stored inside the `data` attribute — not the full DynamoDB item. TypeScript infers all generic parameters from the options object.

```typescript
import { defineTable, typed } from "effortless-aws";

type Order = { tag: string; amount: number; status: string };

// Option 1: typed<T>() — type-only, no runtime validation
export const orders = defineTable({
  schema: typed<Order>(),
});

// Option 2: schema function — with runtime validation
export const orders = defineTable({
  schema: (input: unknown) => {
    const obj = input as Record<string, unknown>;
    if (typeof obj?.amount !== "number") throw new Error("amount required");
    return { tag: String(obj.tag), amount: obj.amount, status: String(obj.status) };
  },
});
```

### Tag field (`tagField`)

Every item has a top-level `tag` attribute in DynamoDB (useful for GSIs and filtering). Effortless auto-extracts it from your data — by default from `data.tag`. If your discriminant field is named differently, set `tagField`:

```typescript
type Order = { type: "order"; amount: number };

export const orders = defineTable({
  tagField: "type",  // → extracts data.type as the DynamoDB tag attribute
  schema: typed<Order>(),
});
```

### Callback arguments

All stream callbacks (`onRecord`, `onBatch`, `onBatchComplete`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `record` / `records` | `TableRecord<T>` / `TableRecord<T>[]` | Stream records with typed `new`/`old` `TableItem<T>` values |
| `table` | `TableClient<T>` | Typed client for **this** table (auto-injected) |
| `ctx` | `C` | Result from `setup()` factory (if provided) |
| `deps` | `{ [key]: TableClient }` | Typed clients for dependent tables (if `deps` is set) |
| `config` | `ResolveConfig<P>` | SSM parameter values (if `config` is set) |

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
export const orders = defineTable({
  schema: typed<Order>(),
  onRecord: async ({ record, table }) => {
    if (record.eventName === "INSERT" && record.new) {
      console.log(`New order: $${record.new.data.amount}`);
    }
  }
});
```

Each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`.

### Batch processing

```typescript
export const events = defineTable({
  schema: typed<ClickEvent>(),
  batchSize: 100,
  onBatch: async ({ records }) => {
    const inserts = records
      .filter(r => r.eventName === "INSERT")
      .map(r => r.new!.data);
    await bulkIndex(inserts);
  }
});
```

All records in a batch are processed together. If the handler throws, all records are reported as failed.

### TableClient

Every table handler receives a `table: TableClient<T>` — a typed client for its own table. Other handlers get it via `deps`. `T` is your domain data type (what goes inside `data`).

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

export const orders = defineTable({
  schema: typed<Order>(),
  deps: { users },
  onRecord: async ({ record, deps }) => {
    const userId = record.new?.data.userId;
    if (userId) {
      const user = await deps.users.get({ pk: `USER#${userId}`, sk: "PROFILE" });
      console.log(`Order by ${user?.data.name}`);
    }
  }
});
```

### Batch accumulation

```typescript
export const ordersWithBatch = defineTable({
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    return { amount: record.new?.data.amount ?? 0 };
  },
  onBatchComplete: async ({ results, failures }) => {
    const total = results.reduce((sum, r) => sum + r.amount, 0);
    console.log(`Batch total: $${total}, failed: ${failures.length}`);
  }
});
```

### Resource-only (no Lambda)

```typescript
// Just creates the DynamoDB table — no stream, no Lambda
export const users = defineTable({
  schema: typed<User>(),
});
```

**Built-in best practices**:
- **Single-table design** — fixed `pk`/`sk`/`tag`/`data`/`ttl` structure. Flexible access patterns via composite keys, no schema migrations needed.
- **Partial batch failures** — each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`. The rest of the batch succeeds.
- **Typed records** — use `schema: typed<Order>()` for type inference, or a validation function for runtime checks. `schema` validates the `data` portion of stream records.
- **Table self-client** — `table` arg provides a typed `TableClient<T>` for the handler's own table, auto-injected with no config.
- **Smart updates** — `update()` auto-prefixes `data.` for domain fields, so you can do partial updates without reading the full item.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for other tables with auto-wired IAM and env vars.
- **Batch accumulation** — `onRecord` return values are collected into `results` for `onBatchComplete`. Use this for bulk writes, aggregations, or reporting.
- **Auto-TTL** — TTL is always enabled on the `ttl` attribute. Set it on `put()` or `update()` and DynamoDB auto-deletes expired items.
- **Conditional writes** — use `{ ifNotExists: true }` on `put()` for idempotent inserts.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations.
- **Progressive complexity** — omit handlers for table-only. Add `onRecord` for stream processing. Add `onBatch` for batch mode. Add `deps` for cross-table access.
- **Auto-infrastructure** — DynamoDB table, stream, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

---

## defineApp

Creates: API Gateway HTTP API + Lambda serving static files.

```typescript
export const app = defineApp({
  // Required
  dir: string,                       // directory with built site files

  // Optional
  path?: string,                     // base URL path (e.g. "/app")
  index?: string,                    // default: "index.html"
  spa?: boolean,                     // SPA mode: serve index for all paths (default: false)
  build?: string,                    // shell command to run before deploy
  memory?: number,                   // Lambda memory in MB (default: 256)
  timeout?: number,                  // Lambda timeout in seconds (default: 5)
});
```

Files are bundled into the Lambda ZIP. The runtime serves them with auto-detected content types, cache headers, and path traversal protection.

```typescript
export const app = defineApp({
  dir: "dist",
  path: "/app",
  build: "npm run build",
});
```

- HTML files: `Cache-Control: public, max-age=0, must-revalidate`
- Other files (JS, CSS, images): `Cache-Control: public, max-age=31536000, immutable`

When `spa: true`, all paths that don't match a file are served with `index.html`. This enables client-side routing (React Router, Vue Router, etc.).

**Built-in best practices**:
- **Content-type detection** — auto-detected from file extensions (HTML, CSS, JS, images, fonts, etc.).
- **Cache headers** — HTML files are revalidated on every request; hashed assets are cached for 1 year.
- **Path traversal protection** — requests attempting `../` traversal are blocked with 403.
- **SPA support** — when `spa: true`, returns `index.html` for paths without file extensions.
- **Auto-infrastructure** — API Gateway HTTP API, route, Lambda integration, and IAM permissions are created on deploy.

For CDN-backed sites (S3 + CloudFront), use [defineStaticSite](#definestaticsite) instead.

---

## defineStaticSite

Creates: S3 bucket + CloudFront distribution + Origin Access Control + CloudFront Function (viewer request) + optional Lambda@Edge (middleware).

```typescript
export const docs = defineStaticSite({
  // Required
  dir: string,                       // directory with built site files

  // Optional
  index?: string,                    // default: "index.html"
  spa?: boolean,                     // SPA mode: serve index for all paths (default: false)
  build?: string,                    // shell command to run before deploy
  domain?: string,                   // custom domain (e.g. "example.com")
  middleware?: (request) => ...,     // Lambda@Edge middleware for auth, redirects, etc.
});
```

Files are synced to S3 and served via CloudFront globally.

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  build: "npx astro build",
});
```

When `spa: true`, CloudFront error responses redirect 403/404 to `index.html`, enabling client-side routing (React Router, Vue Router, etc.).

```typescript
export const dashboard = defineStaticSite({
  dir: "dist",
  spa: true,
  build: "npm run build",
});
```

### Custom domain

Set `domain` to serve your site on a custom domain instead of the default `*.cloudfront.net` URL:

```typescript
export const site = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  domain: "example.com",
});
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

### Middleware (Lambda@Edge)

Add `middleware` to run custom Node.js code before CloudFront serves any page. Use it for authentication, access control, or redirects.

```typescript
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
  middleware: async (request) => {
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }
    // return void → serve the page normally
  },
});
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
});

// Protected admin — with auth middleware
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
  middleware: async (request) => {
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }
  },
});
```
:::

**Built-in best practices**:
- **URL rewriting** — automatically resolves `/path/` to `/path/index.html` via CloudFront Function.
- **SPA support** — when `spa: true`, 403/404 errors return `index.html` for client-side routing.
- **Global distribution** — served via CloudFront edge locations worldwide.
- **Custom domains** — set `domain` for a custom domain with automatic ACM certificate lookup and optional www→non-www redirect.
- **Edge middleware** — add `middleware` for auth checks, redirects, or access control via Lambda@Edge. Full Node.js runtime at the edge — JWT validation, cookie checks, custom logic.
- **Orphan cleanup** — when CloudFront Functions become unused (e.g. after config changes), they are automatically deleted on the next deploy.
- **Auto-infrastructure** — S3 bucket, CloudFront distribution, Origin Access Control, CloudFront Function (or Lambda@Edge), cache invalidation, and SSL certificate configuration on deploy.

---

## defineFifoQueue

Creates: SQS FIFO Queue + Lambda + Event Source Mapping + IAM permissions

```typescript
export const orderQueue = defineFifoQueue({
  // Optional — queue
  batchSize?: number,                   // 1-10, default: 10
  batchWindow?: number,                 // seconds (0-300), default: 0
  visibilityTimeout?: number,           // seconds (default: max of timeout or 30)
  retentionPeriod?: number,             // seconds (60-1209600, default: 345600 = 4 days)
  contentBasedDeduplication?: boolean,  // default: true

  // Optional — lambda
  memory?: number,
  timeout?: number,
  permissions?: Permission[],           // additional IAM permissions
  schema?: (input: unknown) => T,       // validate & parse message body
  setup?: ({ deps, config }) => C,      // factory for shared state (cached on cold start)
  deps?: { [key]: TableHandler },       // inter-handler dependencies
  config?: { [key]: param(...) },       // SSM parameters

  // Handler — choose one mode:

  // Mode 1: per-message processing
  onMessage: async ({ message, ctx, deps, config }) => { ... },

  // Mode 2: batch processing
  onBatch: async ({ messages, ctx, deps, config }) => { ... },
});
```

### Callback arguments

All queue callbacks (`onMessage`, `onBatch`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `message` / `messages` | `FifoQueueMessage<T>` / `FifoQueueMessage<T>[]` | Parsed messages with typed `body` |
| `ctx` | `C` | Result from `setup()` factory (if provided) |
| `deps` | `{ [key]: TableClient }` | Typed clients for dependent tables (if `deps` is set) |
| `config` | `ResolveConfig<P>` | SSM parameter values (if `config` is set) |

The `FifoQueueMessage<T>` object:

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

export const orderQueue = defineFifoQueue({
  schema: typed<OrderEvent>(),
  onMessage: async ({ message }) => {
    console.log(`Order ${message.body.orderId}: ${message.body.action}`);
    await processOrder(message.body);
  },
});
```

Each message is processed individually. If one fails, only that message is retried via `batchItemFailures`. The rest of the batch succeeds.

### Batch processing

```typescript
export const notifications = defineFifoQueue({
  schema: typed<Notification>(),
  batchSize: 5,
  onBatch: async ({ messages }) => {
    await sendAll(messages.map(m => m.body));
  },
});
```

All messages in a batch are processed together. If the handler throws, all messages are reported as failed.

### Schema validation

```typescript
export const events = defineFifoQueue({
  schema: (input) => {
    const obj = input as any;
    if (!obj?.eventType) throw new Error("eventType is required");
    return { eventType: obj.eventType as string, payload: obj.payload };
  },
  onMessage: async ({ message }) => {
    // message.body is typed: { eventType: string; payload: unknown }
  },
});
```

When `schema` throws, the message is reported as a batch item failure automatically.

### Dependencies

```typescript
import { orders } from "./orders.js";

export const orderProcessor = defineFifoQueue({
  schema: typed<OrderEvent>(),
  deps: { orders },
  onMessage: async ({ message, deps }) => {
    // deps.orders is TableClient<Order>
    await deps.orders.put({
      pk: `ORDER#${message.body.orderId}`, sk: "STATUS",
      data: { tag: "order", status: "processing" },
    });
  },
});
```

Dependencies are auto-wired: the framework sets environment variables, IAM permissions, and provides typed `TableClient` instances at runtime.

**Built-in best practices**:
- **Partial batch failures** — each message is processed individually (`onMessage` mode). If one fails, only that message is retried via `batchItemFailures`. The rest of the batch succeeds.
- **FIFO ordering** — messages within the same `messageGroupId` are delivered in order. Use message groups to partition work while maintaining ordering guarantees.
- **Content-based deduplication** — enabled by default. SQS uses the message body hash to prevent duplicates within the 5-minute deduplication interval.
- **Typed messages** — use `schema: typed<OrderEvent>()` or a validation function for typed `message.body` with automatic JSON parsing.
- **Schema validation** — when `schema` is set, each message body is validated before your handler runs. Invalid messages are automatically reported as failures.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for DynamoDB tables with auto-wired IAM and env vars.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations.
- **Auto-infrastructure** — SQS FIFO queue, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

---

## defineSchedule

> **Status: Planned** — not yet implemented.

Creates: EventBridge Rule + Lambda + IAM permissions

```typescript
export const daily = defineSchedule({
  // Required
  schedule: string,  // "rate(1 hour)" or "cron(0 12 * * ? *)"

  // Optional
  memory?: number,
  timeout?: DurationInput,
  enabled?: boolean,  // default true

  handler: async (ctx: ScheduleContext) => {
    // ctx.scheduledTime, ctx.ruleName available
  }
});
```

**Planned best practices**:
- **Auto-infrastructure** — EventBridge rule, Lambda, and IAM permissions are created on deploy. Toggle `enabled` to pause the schedule without deleting resources.

---

## defineEvent

> **Status: Planned** — not yet implemented.

Creates: EventBridge Rule + Lambda for custom events

```typescript
export const orderCreated = defineEvent({
  // Required
  eventPattern: {
    source: ["my.app"],
    "detail-type": ["OrderCreated"],
  },

  // Optional
  eventSchema?: Schema.Schema<T>,

  handler: async (event: T, ctx: EventContext) => {
    // typed event
  }
});
```

**Planned best practices**:
- **Typed events** — when `eventSchema` is set, the event detail is parsed and validated before your handler runs.
- **Auto-infrastructure** — EventBridge rule with pattern matching, Lambda, and IAM permissions are created on deploy.

---

## defineBucket

Creates: S3 Bucket + (optional) Lambda + S3 Event Notifications

Like `defineTable`, `defineBucket` supports **resource-only** mode — omit event callbacks to create just the bucket, referenceable via `deps` from other handlers.

```typescript
export const uploads = defineBucket({
  // Optional — event filters
  prefix?: string,                     // S3 key prefix filter (e.g. "images/")
  suffix?: string,                     // S3 key suffix filter (e.g. ".jpg")

  // Optional — lambda
  memory?: number,
  timeout?: DurationInput,
  permissions?: Permission[],           // additional IAM permissions
  setup?: ({ bucket, deps, config }) => C,  // factory for shared state (cached on cold start)
  deps?: { [key]: Handler },            // inter-handler dependencies
  config?: { [key]: param(...) },       // SSM parameters

  // Event handlers — both optional
  onObjectCreated?: async ({ event, bucket, ctx, deps, config }) => { ... },
  onObjectRemoved?: async ({ event, bucket, ctx, deps, config }) => { ... },
});
```

When at least one event handler is provided, a Lambda is created with S3 event notifications for `ObjectCreated:*` and `ObjectRemoved:*` events, filtered by `prefix`/`suffix` if specified.

### BucketEvent

Both `onObjectCreated` and `onObjectRemoved` receive a `BucketEvent`:

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
| `bucket` | `BucketClient` | Typed client for **this** bucket (auto-injected) |
| `ctx` | `C` | Result from `setup()` factory (if provided) |
| `deps` | `{ [key]: TableClient \| BucketClient }` | Typed clients for dependent handlers (if `deps` is set) |
| `config` | `ResolveConfig<P>` | SSM parameter values (if `config` is set) |

### BucketClient

Every bucket handler receives a `bucket: BucketClient` — a typed client for its own S3 bucket. Other handlers get it via `deps`.

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
export const uploads = defineBucket({
  prefix: "images/",
  suffix: ".jpg",
  onObjectCreated: async ({ event, bucket }) => {
    const file = await bucket.get(event.key);
    console.log(`New image: ${event.key}, size: ${file?.body.length}`);
  },
  onObjectRemoved: async ({ event }) => {
    console.log(`Deleted: ${event.key}`);
  },
});
```

### Dependencies

```typescript
import { orders } from "./orders.js";

export const invoices = defineBucket({
  deps: { orders },
  onObjectCreated: async ({ event, deps }) => {
    // deps.orders is TableClient<Order>
    await deps.orders.put({
      pk: "INVOICE#1", sk: "FILE",
      data: { tag: "invoice", key: event.key, size: event.size ?? 0 },
    });
  },
});
```

### Resource-only (no Lambda)

```typescript
// Just creates the S3 bucket — no event notifications, no Lambda
export const assets = defineBucket({});
```

Use it as a dependency from other handlers:

```typescript
import { assets } from "./assets.js";

export const upload = defineHttp({
  method: "POST",
  path: "/upload",
  deps: { assets },
  onRequest: async ({ req, deps }) => {
    // deps.assets is BucketClient
    await deps.assets.put("uploads/file.txt", req.body);
    return { status: 201 };
  },
});
```

**Built-in best practices**:
- **Filtered triggers** — use `prefix` and `suffix` to limit which S3 events invoke the Lambda, reducing unnecessary invocations.
- **Self-client** — `bucket` arg provides a typed `BucketClient` for the handler's own bucket, auto-injected with no config.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` and `BucketClient` instances with auto-wired IAM and env vars.
- **Resource-only mode** — omit event handlers to create just the bucket. Reference it via `deps` from other handlers.
- **Cold start optimization** — the `setup` factory runs once and is cached across invocations. Receives `bucket` (self-client) alongside `deps` and `config`.
- **Error isolation** — each S3 event record is processed individually. If one fails, the error is logged and the remaining records continue processing.
- **Auto-infrastructure** — S3 bucket, Lambda, S3 event notifications, and IAM permissions are all created on deploy from this single definition.
