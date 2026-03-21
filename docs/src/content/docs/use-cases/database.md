---
title: Database
description: Create DynamoDB tables with defineTable — single-table design, typed clients, stream processing, and event-driven workflows.
---

You need a database for your serverless app. [DynamoDB](/why-serverless/#dynamodb) is a fully managed database with single-digit millisecond latency, automatic replication across availability zones, and a built-in streaming feature that turns every write into a real-time event.

The usual pain with DynamoDB isn't the service itself — it's the setup. CloudFormation templates, IAM policies, event source mappings, environment variable wiring, and the boilerplate of single-table design. With `defineTable` you declare the table once, and get a typed client, stream processing, and automatic IAM wiring — all from a single export.

## Single-table design

Effortless enforces an opinionated **single-table design**. Every table has a fixed structure:

| Attribute | Type | Purpose |
|-----------|------|---------|
| `pk` | String | Partition key — identifies the entity or group |
| `sk` | String | Sort key — identifies the specific item or relationship |
| `tag` | String | Entity type discriminant (auto-managed) |
| `data` | Map | Your domain data (`T`) |
| `ttl` | Number | Optional TTL timestamp for auto-expiration |

You define your domain type `T` — that's what goes inside `data`. The envelope (`pk`, `sk`, `tag`, `ttl`) is managed by effortless. This structure enables flexible access patterns, multiple entity types in one table, and typed clients without raw SDK calls.

## A simple table

You have users and you want to store them in DynamoDB. Define the table with a type.

```typescript
// src/users.ts
import { defineTable, unsafeAs } from "effortless-aws";

type User = { tag: string; email: string; name: string; createdAt: string };

export const users = defineTable({
  schema: unsafeAs<User>(),
});
```

After deploy, you get a DynamoDB table named `{project}-{stage}-users`. Other handlers can reference this table via `deps` and get a typed client for `.put()`, `.get()`, `.delete()`, `.update()`, and `.query()`.

## Writing and reading data

The `TableClient` works with the single-table envelope: `pk`, `sk`, and `data`.

```typescript
// Write an item — tag is auto-extracted from data.tag
await table.put({
  pk: "USER#alice",
  sk: "PROFILE",
  data: { tag: "user", email: "alice@example.com", name: "Alice", createdAt: "2025-01-01" },
});

// Read it back
const item = await table.get({ pk: "USER#alice", sk: "PROFILE" });
// item.data.name → "Alice"
// item.tag → "user" (auto-extracted from data.tag)

// Delete it
await table.delete({ pk: "USER#alice", sk: "PROFILE" });
```

The top-level `tag` attribute in DynamoDB is auto-extracted from your data — by default from `data.tag`. If your discriminant field has a different name (like `type` or `kind`), set `tagField`:

```typescript
type Order = { type: "order"; amount: number; status: string };

export const orders = defineTable({
  tagField: "type",  // → extracts data.type as the DynamoDB tag attribute
  schema: unsafeAs<Order>(),
});
```

## Multiple entity types

The real power of single-table design is storing related entities together. Use composite keys (`pk` + `sk`) and a discriminant field to model relationships.

```typescript
type UserData = { tag: "user"; email: string; name: string };
type OrderData = { tag: "order"; amount: number; status: string; createdAt: string };

// Store user and their orders in the same table
await table.put({
  pk: "USER#alice", sk: "PROFILE",
  data: { tag: "user", email: "alice@example.com", name: "Alice" },
});

await table.put({
  pk: "USER#alice", sk: "ORDER#2025-001",
  data: { tag: "order", amount: 99, status: "pending", createdAt: "2025-01-15" },
});

await table.put({
  pk: "USER#alice", sk: "ORDER#2025-002",
  data: { tag: "order", amount: 250, status: "shipped", createdAt: "2025-01-20" },
});

// Query all orders for a user
const orders = await table.query({
  pk: "USER#alice",
  sk: { begins_with: "ORDER#" },
});

// Query with sorting and limit
const recentOrders = await table.query({
  pk: "USER#alice",
  sk: { begins_with: "ORDER#" },
  limit: 5,
  scanIndexForward: false,  // newest first
});
```

## Reacting to data changes

You want to do something every time a record is inserted, updated, or deleted — send a notification, update a search index, trigger a downstream process. Instead of polling or building a message queue, you can react to DynamoDB stream events directly.

Add `onRecord` and your function runs for every change.

```typescript
// src/orders.ts
import { defineTable, unsafeAs } from "effortless-aws";

type Order = { tag: string; product: string; amount: number; status: string };

export const orders = defineTable({
  schema: unsafeAs<Order>(),
  onRecord: async ({ record }) => {
    if (record.eventName === "INSERT" && record.new) {
      console.log(`New order: ${record.new.data.product} — $${record.new.data.amount}`);
      // Send confirmation email, update analytics, notify warehouse...
    }
    if (record.eventName === "MODIFY" && record.new?.data.status === "shipped") {
      // Send shipping notification
    }
    if (record.eventName === "REMOVE") {
      // Clean up related resources
    }
  },
});
```

The `record` follows the `TableItem<T>` structure:
- `record.eventName` — `"INSERT"`, `"MODIFY"`, or `"REMOVE"`
- `record.new` — the new item as `TableItem<T>` (access domain data via `record.new.data`)
- `record.old` — the previous item as `TableItem<T>`
- `record.keys` — `{ pk: string; sk: string }`

Effortless creates the DynamoDB stream, the Lambda function, and the event source mapping. If your handler throws, only that specific record is reported as a failure — other records in the batch still succeed (partial batch failure handling is built in).

## Batch processing

Processing records one by one is fine for most cases. But when you need to handle high throughput — indexing to Elasticsearch, writing to a data lake, aggregating metrics — you want to work with batches.

Use `onRecordBatch` to receive all records at once.

```typescript
// src/analytics.ts
import { defineTable, unsafeAs } from "effortless-aws";

type ClickEvent = { tag: string; page: string; userId: string; timestamp: string };

export const clickEvents = defineTable({
  schema: unsafeAs<ClickEvent>(),
  batchSize: 100,
  onRecordBatch: async ({ records }) => {
    const inserts = records
      .filter(r => r.eventName === "INSERT")
      .map(r => r.new!.data);

    if (inserts.length > 0) {
      await bulkIndexToElasticsearch(inserts);
    }
  },
});
```

If the handler throws, all records in the batch are reported as failed. For partial failure support, return `{ failures: string[] }` with the sequence numbers of failed records:

```typescript
export const payments = defineTable({
  schema: unsafeAs<Payment>(),
  batchSize: 50,
  onRecordBatch: async ({ records }) => {
    const failures: string[] = [];
    for (const record of records) {
      try {
        await processPayment(record.new!.data);
      } catch {
        if (record.sequenceNumber) failures.push(record.sequenceNumber);
      }
    }
    if (failures.length > 0) return { failures };
  },
});
```

## Updating without reading

You don't always need to read an item before updating it. The `update()` method lets you modify specific fields inside `data` directly — effortless auto-prefixes `data.` in the DynamoDB expression.

```typescript
// Update domain data fields
await table.update({ pk: "USER#alice", sk: "ORDER#2025-001" }, {
  set: { status: "shipped" },
});

// Append to a list field
await table.update({ pk: "USER#alice", sk: "ORDER#2025-001" }, {
  append: { events: ["shipped"] },
});

// Remove a field
await table.update({ pk: "USER#alice", sk: "ORDER#2025-001" }, {
  remove: ["tempNotes"],
});

// Update top-level tag and TTL
await table.update({ pk: "USER#alice", sk: "ORDER#2025-001" }, {
  set: { status: "archived" },
  tag: "archived-order",
  ttl: Math.floor(Date.now() / 1000) + 86400 * 30,  // expire in 30 days
});
```

## TTL (auto-expiration)

TTL is always enabled on the `ttl` attribute. Set a Unix timestamp (in seconds) and DynamoDB automatically deletes the item after that time. No cron jobs, no cleanup Lambda.

```typescript
// Set TTL on put
await table.put({
  pk: "SESSION#abc", sk: "DATA",
  data: { tag: "session", userId: "alice", token: "..." },
  ttl: Math.floor(Date.now() / 1000) + 3600,  // expire in 1 hour
});

// Update TTL on an existing item
await table.update({ pk: "SESSION#abc", sk: "DATA" }, {
  ttl: Math.floor(Date.now() / 1000) + 7200,  // extend to 2 hours
});

// Remove TTL (item never expires)
await table.update({ pk: "SESSION#abc", sk: "DATA" }, {
  ttl: null,
});
```

## Conditional writes

Use `ifNotExists` to prevent overwriting existing items — useful for idempotent operations.

```typescript
try {
  await table.put(
    {
      pk: "USER#alice", sk: "PROFILE",
      data: { tag: "user", email: "alice@example.com", name: "Alice" },
    },
    { ifNotExists: true },
  );
} catch (err) {
  // Item already exists — handle gracefully
}
```

## Using the table from another handler

The real power of `defineTable` is how it composes with other handlers. Any HTTP handler can reference the table via `deps` and get a fully typed client — no table name strings, no raw SDK calls.

```typescript
// src/api.ts
import { defineApi } from "effortless-aws";
import { users } from "./users";

export const getUser = defineApi({
  basePath: "/users",
  deps: () => ({ users }),
})
  .setup(({ deps }) => ({ users: deps.users }))
  .get("/{id}", async ({ req, users }) => {
    const user = await users.get({
      pk: `USER#${req.params.id}`,
      sk: "PROFILE",
    });
    if (!user) return { status: 404, body: { error: "User not found" } };
    return { status: 200, body: user.data };
  });
```

`users` is a `TableClient<User>` — wired through `setup` from `deps`. The Lambda gets IAM permissions for DynamoDB operations on that specific table, all wired automatically.

## Resource-only table

Sometimes you need a table but don't need stream processing — it's just a data store. Skip the `onRecord`/`onRecordBatch` handler and you get a table without a stream Lambda.

```typescript
export const cache = defineTable({
  schema: unsafeAs<CacheEntry>(),
});
// No onRecord — just a table. Reference it with deps from other handlers.
```

## See also

- [Definitions reference — defineTable](/definitions/#definetable) — all configuration options
- [HTTP API use case](/use-cases/http-api/) — how to use deps in HTTP handlers
