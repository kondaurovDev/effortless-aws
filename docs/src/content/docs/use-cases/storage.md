---
title: Storage
description: Create S3 buckets with defineBucket — file uploads, event-driven processing, typed clients, and cross-handler dependencies.
---

You need object storage for your serverless app — file uploads, generated reports, media assets, data exports. [S3](https://aws.amazon.com/s3/) is the obvious choice, but wiring up buckets, event notifications, IAM policies, and Lambda triggers is tedious.

With `defineBucket` you declare the bucket once, and get a typed client, event processing, and automatic IAM wiring — all from a single export.

## A simple bucket

You want to store user uploads. Define the bucket and use it from an HTTP handler.

```typescript
// src/uploads.ts
import { defineBucket } from "effortless-aws";

export const uploads = defineBucket({});
```

After deploy, you get an S3 bucket named `{project}-{stage}-uploads`. Other handlers can reference it via `deps` and get a typed `BucketClient` for `.put()`, `.get()`, `.delete()`, and `.list()`.

```typescript
// src/api.ts
import { defineHttp } from "effortless-aws";
import { uploads } from "./uploads";

export const uploadFile = defineHttp({
  method: "POST",
  path: "/upload/{filename}",
  deps: { uploads },
  onRequest: async ({ req, deps }) => {
    await deps.uploads.put(req.params.filename, req.body);
    return { status: 201, body: { key: req.params.filename } };
  },
});

export const getFile = defineHttp({
  method: "GET",
  path: "/files/{filename}",
  deps: { uploads },
  onRequest: async ({ req, deps }) => {
    const file = await deps.uploads.get(req.params.filename);
    if (!file) return { status: 404, body: { error: "Not found" } };
    return {
      status: 200,
      body: file.body.toString("base64"),
      headers: {
        "content-type": file.contentType ?? "application/octet-stream",
      },
    };
  },
});
```

`deps.uploads` is a `BucketClient` — the Lambda gets IAM permissions for S3 operations on that specific bucket, all wired automatically.

## Reading and writing objects

The `BucketClient` provides four operations:

```typescript
// Upload a string or Buffer
await bucket.put("reports/monthly.csv", csvString);
await bucket.put("images/photo.jpg", imageBuffer, { contentType: "image/jpeg" });

// Download — returns undefined if not found
const file = await bucket.get("reports/monthly.csv");
if (file) {
  console.log(file.body.toString());  // Buffer → string
  console.log(file.contentType);      // "text/csv" or undefined
}

// Delete
await bucket.delete("reports/old.csv");

// List objects, optionally by prefix
const allFiles = await bucket.list();
const reports = await bucket.list("reports/");
// [{ key: "reports/monthly.csv", size: 1024, lastModified: Date }, ...]
```

## Reacting to uploads

You want to do something every time a file is uploaded — generate a thumbnail, scan for viruses, update a database. Instead of polling or building a pipeline, you can react to S3 events directly.

Add `onObjectCreated` and your function runs for every new object.

```typescript
// src/images.ts
import { defineBucket } from "effortless-aws";

export const images = defineBucket({
  prefix: "uploads/",
  suffix: ".jpg",
  onObjectCreated: async ({ event, bucket }) => {
    console.log(`New image: ${event.key}, size: ${event.size} bytes`);
    const file = await bucket.get(event.key);
    if (file) {
      const thumbnail = await generateThumbnail(file.body);
      await bucket.put(`thumbnails/${event.key}`, thumbnail, {
        contentType: "image/jpeg",
      });
    }
  },
});
```

Use `prefix` and `suffix` to filter which objects trigger the Lambda. Only matching objects invoke your function — the rest are ignored.

The `event` object gives you:
- `event.key` — object key (path within the bucket)
- `event.size` — object size in bytes
- `event.eventName` — e.g. `"ObjectCreated:Put"`
- `event.eTag` — object ETag
- `event.eventTime` — ISO 8601 timestamp
- `event.bucketName` — S3 bucket name

## Reacting to deletions

Use `onObjectRemoved` to clean up when objects are deleted.

```typescript
export const documents = defineBucket({
  onObjectCreated: async ({ event }) => {
    await indexDocument(event.key);
  },
  onObjectRemoved: async ({ event }) => {
    await removeFromIndex(event.key);
  },
});
```

You can define both callbacks on the same bucket — each event type routes to the right handler.

## Processing with a database

Most file processors need to read or write data. Define a table and reference it via `deps`.

```typescript
// src/invoices.ts
import { defineTable, defineBucket, typed } from "effortless-aws";

type Invoice = { tag: string; key: string; size: number; uploadedAt: string };

export const invoiceRecords = defineTable({
  schema: typed<Invoice>(),
});

export const invoices = defineBucket({
  prefix: "invoices/",
  deps: { invoiceRecords },
  onObjectCreated: async ({ event, deps }) => {
    await deps.invoiceRecords.put({
      pk: "INVOICE",
      sk: `FILE#${event.key}`,
      data: {
        tag: "invoice",
        key: event.key,
        size: event.size ?? 0,
        uploadedAt: event.eventTime ?? new Date().toISOString(),
      },
    });
  },
});
```

Each Lambda gets only the IAM permissions it needs — S3 for its own bucket, DynamoDB for the referenced table.

## Using a bucket from a table stream

Buckets compose with any handler type, not just HTTP. A table stream handler can write to a bucket via `deps`:

```typescript
import { defineTable, defineBucket, typed } from "effortless-aws";

export const reports = defineBucket({});

type Order = { tag: string; amount: number; status: string };

export const orders = defineTable({
  schema: typed<Order>(),
  deps: { reports },
  onRecord: async ({ record, deps }) => {
    if (record.eventName === "INSERT" && record.new) {
      const csv = `${record.new.pk},${record.new.data.amount},${record.new.data.status}\n`;
      await deps.reports.put(`orders/${record.new.pk}.csv`, csv);
    }
  },
});
```

## Resource-only bucket

When you don't need event processing — just a bucket that other handlers write to — omit the callbacks entirely. No Lambda is created.

```typescript
export const assets = defineBucket({});
// No onObjectCreated/onObjectRemoved — just a bucket.
// Reference it with deps from other handlers.
```

## See also

- [Definitions reference — defineBucket](/definitions/#definebucket) — all configuration options
- [Database guide](/use-cases/database/) — how to define tables and use them as deps
- [HTTP API guide](/use-cases/http-api/) — how to use deps in HTTP handlers
