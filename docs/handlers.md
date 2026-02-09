# Handlers

| Handler | Status |
|---------|--------|
| [defineHttp](#definehttp) | Available |
| [defineTable](#definetable) | Available |
| [defineQueue](#definequeue) | Planned |
| [defineSchedule](#defineschedule) | Planned |
| [defineEvent](#defineevent) | Planned |
| [defineS3](#defines3) | Planned |

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
  context?: () => C,                  // factory for dependencies (cached on cold start)
  deps?: { [key]: TableHandler },     // inter-handler dependencies

  onRequest: async ({ req, ctx, data, deps }) => {
    // req.method, req.path, req.headers, req.query, req.params, req.body
    // ctx — context if provided
    // data — parsed body (when schema is set)
    // deps — typed table clients (when deps is set)
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

Dependencies are auto-wired: the framework sets environment variables, IAM permissions, and provides typed `TableClient` instances at runtime. See [architecture.md](architecture.md#inter-handler-dependencies-deps) for details.

**Built-in best practices**:
- **Cold start optimization** — the `context` factory runs once on cold start and is cached across invocations. Use it for DB connections, SDK clients, config loading.
- **Schema validation** — when `schema` is set, the body is parsed and validated before `onRequest` runs. Invalid requests get a 400 response automatically.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances with auto-wired IAM permissions and environment variables.
- **Auto-infrastructure** — API Gateway HTTP API, route, Lambda integration, and IAM permissions are created on deploy.

---

## defineTable

Creates: DynamoDB Table + (optional) Stream + Lambda + Event Source Mapping

```typescript
type Order = {
  id: string;
  createdAt: number;
  amount: number;
};

export const orders = defineTable<Order>({
  // Required
  pk: { name: string, type: "string" | "number" | "binary" },

  // Optional - table
  name?: string,                      // defaults to export name
  sk?: { name: string, type: "string" | "number" | "binary" },
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED",  // default: PAY_PER_REQUEST
  ttlAttribute?: string,

  // Optional - stream
  streamView?: "NEW_AND_OLD_IMAGES" | "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY",  // default: NEW_AND_OLD_IMAGES
  batchSize?: number,                // 1-10000, default: 100
  startingPosition?: "LATEST" | "TRIM_HORIZON",  // default: LATEST

  // Optional - lambda
  memory?: number,
  timeout?: DurationInput,
  permissions?: Permission[],         // additional IAM permissions
  context?: () => C,                  // factory for dependencies (cached on cold start)
  deps?: { [key]: TableHandler },     // inter-handler dependencies

  // Stream handler — choose one mode:

  // Mode 1: per-record processing
  onRecord: async ({ record, table, ctx, deps }) => { ... },
  onBatchComplete?: async ({ results, failures, table, ctx, deps }) => { ... },

  // Mode 2: batch processing
  onBatch: async ({ records, table, ctx, deps }) => { ... },
});
```

### Callback arguments

All stream callbacks (`onRecord`, `onBatch`, `onBatchComplete`) receive:

| Arg | Type | Description |
|-----|------|-------------|
| `record` / `records` | `TableRecord<T>` / `TableRecord<T>[]` | Stream records with typed `new`/`old` values |
| `table` | `TableClient<T>` | Typed client for **this** table (auto-injected) |
| `ctx` | `C` | Context from `context()` factory (if provided) |
| `deps` | `{ [key]: TableClient }` | Typed clients for dependent tables (if `deps` is set) |

### Per-record processing

```typescript
export const orders = defineTable<Order>({
  pk: { name: "id", type: "string" },
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
export const events = defineTable<Event>({
  pk: { name: "id", type: "string" },
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

export const orders = defineTable<Order>({
  pk: { name: "id", type: "string" },
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
export const ordersWithBatch = defineTable<Order>({
  pk: { name: "id", type: "string" },
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
  pk: { name: "id", type: "string" }
});
```

**Built-in best practices**:
- **Partial batch failures** — each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`. The rest of the batch succeeds.
- **Typed records** — the generic `defineTable<Order>` gives you typed `record.new` and `record.old` with automatic DynamoDB unmarshalling.
- **Table self-client** — `table` arg provides a typed `TableClient<T>` for the handler's own table, auto-injected with no config.
- **Typed dependencies** — `deps` provides typed `TableClient<T>` instances for other tables with auto-wired IAM and env vars.
- **Batch accumulation** — `onRecord` return values are collected into `results` for `onBatchComplete`. Use this for bulk writes, aggregations, or reporting.
- **Cold start optimization** — the `context` factory runs once and is cached across invocations.
- **Progressive complexity** — omit handlers for table-only. Add `onRecord` for stream processing. Add `onBatch` for batch mode. Add `deps` for cross-table access.
- **Auto-infrastructure** — DynamoDB table, stream, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

---

## defineQueue

> **Status: Planned** — not yet implemented.

Creates: SQS Queue + Lambda + Event Source Mapping + IAM permissions

```typescript
export const handler = defineQueue({
  // Optional
  name?: string,                      // defaults to export name
  memory?: number,                    // MB, default from config
  timeout?: DurationInput,            // e.g. "30 seconds"
  batchSize?: number,                 // 1-10, default 10
  visibilityTimeout?: DurationInput,  // default "30 seconds"
  messageSchema?: Schema.Schema<T>,   // for type-safe messages
  fifo?: boolean,                     // FIFO queue
  deadLetterQueue?: boolean | string, // enable DLQ or reference existing

  handler: async (messages: T[], ctx: QueueContext) => {
    // messages are already parsed and validated
    // ctx contains raw event, AWS context, logger
  }
});
```

**Planned best practices**:
- **Partial batch failures** — if one message fails, only that message is retried. The rest of the batch succeeds.
- **Typed messages** — when `messageSchema` is set, messages are parsed and validated before your handler runs. Invalid messages are reported as failures automatically.
- **Auto-infrastructure** — SQS queue, Lambda, event source mapping, and IAM permissions are all created on deploy from this single definition.

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
