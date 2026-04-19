---
title: Queue
description: Process messages with defineQueue — ordered delivery, typed messages, partial failures, and database integration.
---

You need to process tasks asynchronously — order fulfillment, email sending, webhook delivery, data imports. You want guaranteed delivery, ordering, and the ability to retry individual failures without reprocessing the entire batch.

With `defineQueue` you write a message handler, export it, and get a production queue backed by [SQS FIFO + Lambda](/why-serverless/#sqs-fifo).

## A simple queue

You want to process order events asynchronously. Each message contains an order ID and an action.

```typescript
// src/order-queue.ts
import { defineQueue } from "effortless-aws";

type OrderEvent = { orderId: string; action: "created" | "shipped" | "cancelled" };

export const orderQueue = defineQueue<OrderEvent>({ fifo: true })
  .onMessage(async ({ message }) => {
    console.log(`Order ${message.body.orderId}: ${message.body.action}`);
    // Process the order event...
  });
```

After `eff deploy`, you get an SQS FIFO queue named `{project}-{stage}-orderQueue.fifo` and a Lambda that processes each message. If your handler throws, only that specific message is retried — the rest of the batch succeeds.

The `message` object gives you:
- `message.body` — parsed and typed message body (`OrderEvent`)
- `message.messageId` — unique SQS message ID
- `message.messageGroupId` — FIFO ordering key
- `message.rawBody` — raw string before JSON parsing
- `message.messageAttributes` — SQS message attributes

## Validating messages

Not every message will be well-formed. You want the framework to reject invalid messages before your code processes them.

Pass a `schema` function and Effortless validates every message body automatically. Invalid messages are reported as batch item failures — your handler never sees bad data.

```typescript
import { defineQueue } from "effortless-aws";
import { z } from "zod";

const PaymentEvent = z.object({
  paymentId: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
});

export const paymentQueue = defineQueue({
  fifo: true,
  schema: (input) => PaymentEvent.parse(input),
})
  .onMessage(async ({ message }) => {
    // message.body is typed: { paymentId: string, amount: number, currency: string }
    await chargeCustomer(message.body.paymentId, message.body.amount);
  });
```

## Processing with a database

Most queue processors need to read or write data. Define a table and reference it via `deps` — the framework wires table name, IAM permissions, and typed client automatically.

```typescript
// src/fulfillment.ts
import { defineTable, defineQueue } from "effortless-aws";

type Order = { tag: string; product: string; amount: number; status: string };

export const orders = defineTable<Order>().build();

type FulfillmentEvent = { orderId: string; warehouse: string };

export const fulfillment = defineQueue<FulfillmentEvent>({ fifo: true })
  .deps(() => ({ orders }))
  .setup(({ deps }) => ({ orders: deps.orders }))
  .onMessage(async ({ message, orders }) => {
    // orders is TableClient<Order> — typed from the table's generic
    const pk = `ORDER#${message.body.orderId}`;
    const order = await orders.get({ pk, sk: "DETAIL" });
    if (!order) return;

    await orders.update({ pk, sk: "DETAIL" }, { set: { status: "fulfilling" } });
    await shipFromWarehouse(message.body.warehouse, order.data);
    await orders.update({ pk, sk: "DETAIL" }, { set: { status: "shipped" } });
  });
```

Each Lambda gets only the DynamoDB permissions it needs. No manual IAM policies.

## Batch processing

Processing messages one by one is fine for most cases. But when you need to handle high throughput — bulk database writes, batch API calls, aggregated operations — you want to work with the entire batch at once.

Use `onMessageBatch` instead of `onMessage`:

```typescript
// src/analytics.ts
import { defineQueue } from "effortless-aws";

type ClickEvent = { page: string; userId: string; timestamp: string };

export const clickEvents = defineQueue<ClickEvent>({ fifo: true })
  .poller({ batchSize: 10 })
  .onMessageBatch(async ({ messages }) => {
    const events = messages.map(m => m.body);
    await bulkInsertToAnalytics(events);
  });
```

With `onMessageBatch`, if the handler throws, all messages in the batch are reported as failed. For partial failure support, return `{ failures: string[] }` with the messageIds of failed messages. Use this when individual message processing doesn't make sense — bulk inserts, batch API calls, or all-or-nothing operations.

## Using secrets

Your queue processor calls an external API that requires authentication. Use `.config(({ defineSecret }) => ...)` to reference an SSM Parameter Store key — Effortless fetches the value once on cold start, caches it, and injects it as a typed argument.

```typescript
import { defineQueue } from "effortless-aws";

type WebhookEvent = { url: string; payload: Record<string, unknown> };

export const webhookQueue = defineQueue<WebhookEvent>({ fifo: true })
  .config(({ defineSecret }) => ({
    apiKey: defineSecret({ key: "webhook/api-key" }),
  }))
  .setup(({ config }) => ({ apiKey: config.apiKey }))
  .onMessage(async ({ message, apiKey }) => {
    await fetch(message.body.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(message.body.payload),
    });
  });
```

Store the secret in SSM with `aws ssm put-parameter --name /my-service/dev/webhook/api-key --value sk_... --type SecureString`.

## When to use queues vs streams

Both `defineQueue` and `defineTable` (with stream handlers) process events asynchronously. Here's when to choose each:

**Use `defineTable` streams when**:
- Events are triggered by database writes (insert, update, delete)
- You want a reactive, event-driven architecture tied to your data model
- You need the old and new values of a record for change detection

**Use `defineQueue` when**:
- You need to decouple producers from consumers — the sender doesn't write to a table
- External systems push events (webhooks, third-party integrations)
- You need ordering guarantees across producers via message groups
- You want explicit control over retry behavior and visibility timeout
- The work item doesn't naturally map to a database record

## Tuning queue behavior

FIFO queues have several knobs you can adjust:

```typescript
export const importQueue = defineQueue<ImportEvent>({
  fifo: true,
  visibilityTimeout: "120s",      // before retry (default: max of Lambda timeout or 30s)
  retentionPeriod: "1d",          // message retention (default: 4d)
  contentBasedDeduplication: true, // default: true
})
  .poller({
    batchSize: 5,          // messages per Lambda invocation (1-10, default: 10)
    batchWindow: "10s",    // gather messages before invoking (0s-300s, default: 0)
  })
  .setup({ memory: 512, timeout: "60s" })   // Lambda memory + timeout
  .onMessage(async ({ message }) => {
    await processImport(message.body);
  });
```

The `visibilityTimeout` is automatically set to at least your Lambda timeout — this prevents messages from being retried while still being processed. Lambda-side settings (`memory`, `timeout`, `permissions`, `logLevel`) go inside `.setup({...})`; queue-level settings (`visibilityTimeout`, `retentionPeriod`, etc.) stay in the options object.

## See also

- [Definitions reference — defineQueue](/definitions/#definequeue) — all configuration options
- [Database guide](/use-cases/database/) — how to define tables and use them as deps
- [HTTP API guide](/use-cases/http-api/) — how to use deps and params in HTTP handlers
