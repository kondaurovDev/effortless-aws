---
title: Handlers
description: All handler types — defineHttp, defineTable, defineApp, defineStaticSite, defineFifoQueue, defineSchedule, defineEvent, defineS3.
---

| Handler | Status |
|---------|--------|
| [defineHttp](#definehttp) | Available |
| [defineTable](#definetable) | Available |
| [defineApp](#defineapp) | Available |
| [defineStaticSite](#definestaticsite) | Available |
| [defineFifoQueue](#definefifoqueue) | Available |
| [defineSchedule](#defineschedule) | Planned |
| [defineEvent](#defineevent) | Planned |
| [defineS3](#defines3) | Planned |

---

## Type inference

Every handler function (`defineHttp`, `defineTable`, `defineFifoQueue`) uses TypeScript generics internally to connect types across `schema`, `setup`, `deps`, `config`, and callbacks. You don't need to specify these generics yourself — TypeScript infers them automatically from the options you pass.

Use `schema` to provide the data type. For type-only schemas (no runtime validation), use the `typed<T>()` helper:

```typescript
import { defineTable, defineHttp, defineFifoQueue, typed, param } from "effortless-aws";

type Order = { id: string; amount: number; status: string };

export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),          // T = Order — inferred from schema
  config: {
    threshold: param("threshold", Number),
  },
  setup: async ({ config }) => ({    // C = { db: Pool } — inferred from return type
    db: createPool(config.threshold),
  }),
  deps: { users },                   // D — inferred from deps object
  onRecord: async ({ record, ctx, deps, config }) => {
    // record.new is Order | undefined
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

Dependencies on other table handlers. The framework auto-wires environment variables, IAM permissions, and injects typed `TableClient<T>` instances at runtime.

```typescript
import { orders } from "./orders.js";

deps: { orders },
// → deps.orders is TableClient<Order>
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

Glob patterns for files to bundle into the Lambda ZIP. At runtime, read them via the `readStatic` callback argument.

```typescript
static: ["src/templates/*.ejs"],
// → readStatic("src/templates/invoice.ejs") returns file contents as string
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
  name?: string,                      // defaults to export name
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
    await deps.orders.put({ orderId: "abc-123", amount: 99 });
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

```typescript
export const orders = defineTable({
  // Required
  pk: { name: string, type: "string" | "number" | "binary" },

  // Optional — type inference
  schema?: (input: unknown) => T,     // infers record type T (or use typed<T>())

  // Optional — table
  name?: string,                      // defaults to export name
  sk?: { name: string, type: "string" | "number" | "binary" },
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED",  // default: PAY_PER_REQUEST
  ttlAttribute?: string,

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

Use `schema` or `typed<T>()` to provide the record type. This enables TypeScript to infer all generic parameters from the options object — no need for explicit generics like `defineTable<Order>(...)`.

```typescript
import { defineTable, typed } from "effortless-aws";

type Order = { id: string; amount: number; status: string };

// Option 1: typed<T>() — type-only, no runtime validation
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
});

// Option 2: schema function — with runtime validation
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: Schema.decodeUnknownSync(OrderSchema),
});
```

### Callback arguments

All stream callbacks (`onRecord`, `onBatch`, `onBatchComplete`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `record` / `records` | `TableRecord<T>` / `TableRecord<T>[]` | Stream records with typed `new`/`old` values |
| `table` | `TableClient<T>` | Typed client for **this** table (auto-injected) |
| `ctx` | `C` | Result from `setup()` factory (if provided) |
| `deps` | `{ [key]: TableClient }` | Typed clients for dependent tables (if `deps` is set) |
| `config` | `ResolveConfig<P>` | SSM parameter values (if `config` is set) |

### Per-record processing

```typescript
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record, table }) => {
    if (record.eventName === "INSERT") {
      // table is TableClient<Order> — write back to the same table
      await table.put({ ...record.new!, status: "processed" });
    }
  }
});
```

Each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`.

### Batch processing

```typescript
export const events = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Event>(),
  onBatch: async ({ records, table }) => {
    // Process all records at once
    for (const r of records) {
      await table.put({ ...r.new!, processed: true });
    }
  }
});
```

All records in a batch are processed together. If the handler throws, all records are reported as failed.

### Table self-client (`table`)

Every table handler automatically receives a `table: TableClient<T>` argument — a typed client for its own table. No configuration needed. Use it to read/write back to the same table from stream handlers.

```typescript
TableClient<T>
  put(item: T): Promise<void>
  get(key: Partial<T>): Promise<T | undefined>
  delete(key: Partial<T>): Promise<void>
  query(params: QueryParams): Promise<T[]>
  tableName: string
```

### Dependencies

```typescript
import { users } from "./users.js";

export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  deps: { users },
  onRecord: async ({ record, table, deps }) => {
    // deps.users is TableClient<User>
    const user = await deps.users.get({ id: record.new!.userId });
    await table.put({ ...record.new!, userName: user?.name });
  }
});
```

### Batch accumulation

```typescript
export const ordersWithBatch = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    // Return value is collected into results array
    return { id: record.new!.id, amount: record.new!.amount };
  },
  onBatchComplete: async ({ results, failures, table }) => {
    // results: { id, amount }[] — accumulated from onRecord
    // failures: FailedRecord<Order>[] — records that threw
    console.log(`Processed ${results.length}, failed ${failures.length}`);
  }
});
```

### Resource-only (no Lambda)

```typescript
// Just creates the DynamoDB table — no stream, no Lambda
export const users = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<User>(),
});
```

**Built-in best practices**:
- **Partial batch failures** — each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`. The rest of the batch succeeds.
- **Typed records** — use `schema: typed<Order>()` for type inference, or a validation function for runtime checks. Gives you typed `record.new` and `record.old` with automatic DynamoDB unmarshalling.
- **Table self-client** — `table` arg provides a typed `TableClient<T>` for the handler's own table, auto-injected with no config.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for other tables with auto-wired IAM and env vars.
- **Batch accumulation** — `onRecord` return values are collected into `results` for `onBatchComplete`. Use this for bulk writes, aggregations, or reporting.
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
  name?: string,                     // defaults to export name
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

Creates: S3 bucket + CloudFront distribution + Origin Access Control.

```typescript
export const docs = defineStaticSite({
  // Required
  dir: string,                       // directory with built site files

  // Optional
  name?: string,                     // defaults to export name
  index?: string,                    // default: "index.html"
  spa?: boolean,                     // SPA mode: serve index for all paths (default: false)
  build?: string,                    // shell command to run before deploy
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

**Built-in best practices**:
- **URL rewriting** — automatically resolves `/path/` to `/path/index.html` via CloudFront Function.
- **SPA support** — when `spa: true`, 403/404 errors return `index.html` for client-side routing.
- **Global distribution** — served via CloudFront edge locations worldwide.
- **Auto-infrastructure** — S3 bucket, CloudFront distribution, Origin Access Control, and cache invalidation on deploy.

---

## defineFifoQueue

Creates: SQS FIFO Queue + Lambda + Event Source Mapping + IAM permissions

```typescript
export const orderQueue = defineFifoQueue({
  // Optional — queue
  name?: string,                        // defaults to export name
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
    await deps.orders.put({ id: message.body.orderId, status: "processing" });
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
  name?: string,
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
  name?: string,
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

## defineS3

> **Status: Planned** — not yet implemented.

Creates: S3 Event Notification + Lambda

```typescript
export const upload = defineS3({
  // Required
  bucket: string,  // bucket name or reference
  events: ["s3:ObjectCreated:*"],

  // Optional
  name?: string,
  prefix?: string,
  suffix?: string,

  handler: async (records: S3Record[], ctx: S3Context) => {
    for (const record of records) {
      console.log(`New file: ${record.s3.object.key}`);
    }
  }
});
```

**Planned best practices**:
- **Filtered triggers** — use `prefix` and `suffix` to only invoke the Lambda for relevant objects, reducing unnecessary invocations.
- **Auto-infrastructure** — S3 event notification, Lambda, and IAM permissions are created on deploy.
