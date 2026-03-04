---
title: Queue
description: Process messages with defineFifoQueue — ordered delivery, typed messages, partial failures, and database integration.
---

You need to process tasks asynchronously — order fulfillment, email sending, webhook delivery, data imports. You want guaranteed delivery, ordering, and the ability to retry individual failures without reprocessing the entire batch.

With `defineFifoQueue` you write a message handler, export it, and get a production queue backed by [SQS FIFO + Lambda](/why-serverless/#sqs-fifo).

## A simple queue

You want to process order events asynchronously. Each message contains an order ID and an action.

```typescript
// src/order-queue.ts
import { defineFifoQueue, typed } from "effortless-aws";

type OrderEvent = { orderId: string; action: "created" | "shipped" | "cancelled" };

export const orderQueue = defineFifoQueue({
  schema: typed<OrderEvent>(),
  onMessage: async ({ message }) => {
    console.log(`Order ${message.body.orderId}: ${message.body.action}`);
    // Process the order event...
  },
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
import { defineFifoQueue } from "effortless-aws";
import { z } from "zod";

const PaymentEvent = z.object({
  paymentId: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
});

export const paymentQueue = defineFifoQueue({
  schema: (input) => PaymentEvent.parse(input),
  onMessage: async ({ message }) => {
    // message.body is typed: { paymentId: string, amount: number, currency: string }
    await chargeCustomer(message.body.paymentId, message.body.amount);
  },
});
```

## Processing with a database

Most queue processors need to read or write data. Define a table and reference it via `deps` — the framework wires table name, IAM permissions, and typed client automatically.

```typescript
// src/fulfillment.ts
import { defineTable, defineFifoQueue, typed } from "effortless-aws";

type Order = { id: string; product: string; amount: number; status: string };

export const orders = defineTable({
  schema: typed<Order>(),
});

type FulfillmentEvent = { orderId: string; warehouse: string };

export const fulfillment = defineFifoQueue({
  schema: typed<FulfillmentEvent>(),
  deps: { orders },
  onMessage: async ({ message, deps }) => {
    // deps.orders is TableClient<Order> — typed from the table's generic
    const order = await deps.orders.get({ id: message.body.orderId });
    if (!order) return;

    await deps.orders.put({ ...order, status: "fulfilling" });
    await shipFromWarehouse(message.body.warehouse, order);
    await deps.orders.put({ ...order, status: "shipped" });
  },
});
```

Each Lambda gets only the DynamoDB permissions it needs. No manual IAM policies.

## Batch processing

Processing messages one by one is fine for most cases. But when you need to handle high throughput — bulk database writes, batch API calls, aggregated operations — you want to work with the entire batch at once.

Use `onBatch` instead of `onMessage`:

```typescript
// src/analytics.ts
import { defineFifoQueue, typed } from "effortless-aws";

type ClickEvent = { page: string; userId: string; timestamp: string };

export const clickEvents = defineFifoQueue({
  schema: typed<ClickEvent>(),
  batchSize: 10,
  onBatch: async ({ messages }) => {
    const events = messages.map(m => m.body);
    await bulkInsertToAnalytics(events);
  },
});
```

With `onBatch`, if the handler throws, all messages in the batch are reported as failed. Use this when individual message processing doesn't make sense — bulk inserts, batch API calls, or all-or-nothing operations.

## Using secrets

Your queue processor calls an external API that requires authentication. Use `param()` to reference an SSM Parameter Store key — Effortless fetches the value once on cold start, caches it, and injects it as a typed argument.

```typescript
import { defineFifoQueue, typed, param } from "effortless-aws";

type WebhookEvent = { url: string; payload: Record<string, unknown> };

export const webhookQueue = defineFifoQueue({
  schema: typed<WebhookEvent>(),
  params: {
    apiKey: param("webhook/api-key"),
  },
  onMessage: async ({ message, params }) => {
    await fetch(message.body.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${params.apiKey}` },
      body: JSON.stringify(message.body.payload),
    });
  },
});
```

Store the secret in SSM with `aws ssm put-parameter --name /my-service/dev/webhook/api-key --value sk_... --type SecureString`.

## When to use queues vs streams

Both `defineFifoQueue` and `defineTable` (with stream handlers) process events asynchronously. Here's when to choose each:

**Use `defineTable` streams when**:
- Events are triggered by database writes (insert, update, delete)
- You want a reactive, event-driven architecture tied to your data model
- You need the old and new values of a record for change detection

**Use `defineFifoQueue` when**:
- You need to decouple producers from consumers — the sender doesn't write to a table
- External systems push events (webhooks, third-party integrations)
- You need ordering guarantees across producers via message groups
- You want explicit control over retry behavior and visibility timeout
- The work item doesn't naturally map to a database record

## Tuning queue behavior

FIFO queues have several knobs you can adjust:

```typescript
export const importQueue = defineFifoQueue({
  schema: typed<ImportEvent>(),
  batchSize: 5,           // messages per Lambda invocation (1-10, default: 10)
  batchWindow: 10,        // seconds to wait gathering messages (0-300, default: 0)
  visibilityTimeout: 120, // seconds before retry (default: max of timeout or 30)
  retentionPeriod: 86400, // message retention in seconds (default: 345600 = 4 days)
  timeout: 60,            // Lambda timeout in seconds (default: 30)
  memory: 512,            // Lambda memory in MB (default: 256)
  contentBasedDeduplication: true, // default: true
  onMessage: async ({ message }) => {
    await processImport(message.body);
  },
});
```

The `visibilityTimeout` is automatically set to at least your Lambda timeout — this prevents messages from being retried while still being processed.

## See also

- [Definitions reference — defineFifoQueue](/definitions/#definefifoqueue) — all configuration options
- [Database guide](/use-cases/database/) — how to define tables and use them as deps
- [HTTP API guide](/use-cases/http-api/) — how to use deps and params in HTTP handlers
