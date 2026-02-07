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
  cors?: boolean | CorsConfig,
  auth?: "none" | "iam" | "jwt" | AuthConfig,
  requestSchema?: Schema.Schema<T>,   // validate request body
  context?: () => C,                  // factory for dependencies (cached on cold start)

  onRequest: async ({ req, ctx }: { req: HttpRequest<T>, ctx?: C }) => {
    // req.body is typed and validated
    // req.params, req.query, req.headers available
    // ctx contains context if provided
    return {
      status: 200,
      body: { data: "response" },
      headers?: { ... },
    };
  }
});
```

**Built-in best practices**:
- **Cold start optimization** — the `context` factory runs once on cold start and is cached across invocations. Use it for DB connections, SDK clients, config loading.
- **Typed request body** — when `requestSchema` is set, the body is parsed and validated before `onRequest` runs. Invalid requests get a 400 response automatically.
- **Auto-infrastructure** — API Gateway HTTP API, route, Lambda integration, and IAM permissions are created on deploy.

---

## defineTable

Creates: DynamoDB Table + (optional) Stream + Lambda + Event Source Mapping

```typescript
// With type - record.new/old are typed
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

  // Optional - stream (only if onRecord is provided)
  streamView?: "NEW_AND_OLD_IMAGES" | "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY",  // default: NEW_AND_OLD_IMAGES
  batchSize?: number,                // 1-10000, default: 100
  startingPosition?: "LATEST" | "TRIM_HORIZON",  // default: LATEST
  filterPatterns?: FilterPattern[],  // filter events

  // Optional - lambda
  memory?: number,
  timeout?: DurationInput,
  context?: () => C,                  // factory for dependencies (cached on cold start)

  // Optional - if omitted, only the table is created (no Lambda)
  // Called once per record - partial batch failures handled automatically
  onRecord: async ({ record, ctx }: { record: TableRecord<Order>, ctx?: C }) => {
    if (record.eventName === "INSERT") {
      console.log("New:", record.new);  // Order
    }
    if (record.eventName === "MODIFY") {
      console.log("Changed:", record.old, "→", record.new);
    }
    if (record.eventName === "REMOVE") {
      console.log("Deleted:", record.old);
    }
  }
});

// Without onRecord - just creates the table (no Lambda, no stream)
export const users = defineTable({
  pk: { name: "id", type: "string" }
});

// Without type - record.new/old is Record<string, unknown>
export const logs = defineTable({
  pk: { name: "id", type: "string" },
  onRecord: async ({ record }) => {
    console.log(record.eventName, record.new);
  }
});

// With onBatchComplete - accumulate results and process at end
type ProcessedOrder = { id: string; amount: number };

export const ordersWithBatch = defineTable<Order>({
  pk: { name: "id", type: "string" },

  // Return value is collected into results array
  onRecord: async ({ record }) => {
    // TypeScript infers R = ProcessedOrder from return type
    return { id: record.new!.id, amount: record.new!.amount };
  },

  // Called after all records processed
  onBatchComplete: async ({ results, failures }) => {
    // results: ProcessedOrder[] - accumulated from onRecord
    // failures: FailedRecord<Order>[] - records that threw errors
    console.log(`Processed ${results.length}, failed ${failures.length}`);
    await batchWriteToAnotherTable(results);
  }
});
```

**Built-in best practices**:
- **Partial batch failures** — each record is processed individually. If one fails, only that record is retried via `PartialBatchResponse`. The rest of the batch succeeds.
- **Typed records** — the generic `defineTable<Order>` gives you typed `record.new` and `record.old` with automatic DynamoDB unmarshalling.
- **Batch accumulation** — `onRecord` return values are collected into `results` for `onBatchComplete`. Use this for bulk writes, aggregations, or reporting.
- **Failure tracking** — failed records are captured as `FailedRecord<T>` with the original record and error, available in `onBatchComplete`.
- **Cold start optimization** — the `context` factory runs once and is cached across invocations.
- **Progressive complexity** — omit `onRecord` for a table-only definition. Add it for stream processing. Add `onBatchComplete` for batch operations. Each level builds on the previous one.
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
