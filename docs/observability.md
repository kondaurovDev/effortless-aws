# Observability

## Overview

Every handler deployed by effortless automatically logs executions and errors to a shared **platform table** in DynamoDB. No configuration required — observability is built into the runtime.

```
Handler invocation
       │
       ├─ success → appendExecution (input summary, output summary, duration)
       │
       └─ error   → appendError (input summary, error message, duration)
```

All writes are **fire-and-forget** — they never affect handler response time or error behavior. If the platform table is unavailable, writes are silently dropped.

## Platform Table

A shared DynamoDB table `{project}-{stage}-platform` is automatically created on deploy for every stage.

| Property | Value |
|----------|-------|
| **Table name** | `{project}-{stage}-platform` |
| **Partition key** | `pk` (string) |
| **Sort key** | `sk` (string) |
| **TTL attribute** | `ttl` |
| **Billing** | PAY_PER_REQUEST |

Every Lambda receives the `EFF_PLATFORM_TABLE` environment variable pointing to this table. IAM permissions (`PutItem`, `GetItem`, `UpdateItem`, `Query`) are automatically included in all handler roles.

## Data Model

The platform table uses a single-table design with a discriminated union via `type` field.

### Execution Log

Each handler gets a daily log bucket that accumulates executions and errors as list attributes:

| Key | Value |
|-----|-------|
| **PK** | `HANDLER#{handlerName}` |
| **SK** | `EXEC#{YYYY-MM-DD}` |
| **type** | `"execution-log"` |
| **handlerName** | Handler name |
| **handlerType** | `"http"` or `"table"` |
| **executions** | List of `ExecutionEntry` |
| **errors** | List of `ErrorEntry` |
| **ttl** | 7 days from write |

### Entry Structures

**ExecutionEntry** — logged on successful invocations:

```typescript
{
  id: string;     // UUID
  ts: string;     // ISO 8601 timestamp
  ms: number;     // Duration in milliseconds
  in: unknown;    // Input summary (truncated to 4096 chars)
  out?: unknown;  // Output summary (truncated to 4096 chars)
}
```

**ErrorEntry** — logged on validation or handler errors:

```typescript
{
  id: string;     // UUID
  ts: string;     // ISO 8601 timestamp
  ms: number;     // Duration in milliseconds
  in: unknown;    // Input summary (truncated to 4096 chars)
  err: string;    // Error message
}
```

### What Gets Logged

**HTTP handlers** (`defineHttp`):

| Event | Logged As | Input | Output |
|-------|-----------|-------|--------|
| Schema validation error | `appendError` | `{ method, path, query, body }` | Error message |
| `onRequest` success | `appendExecution` | `{ method, path, query, body }` | Response body |
| `onRequest` throws | `appendError` | `{ method, path, query, body }` | Error message |

**Table stream handlers** (`defineTable`):

| Event | Logged As | Input | Output |
|-------|-----------|-------|--------|
| Record parsing error | `appendError` | `{ recordCount }` | Error message |
| Batch processed (no failures) | `appendExecution` | `{ recordCount }` | `{ processedCount }` |
| Batch processed (with failures) | `appendError` | `{ recordCount }` | `"N record(s) failed"` |

## Storage Mechanism

Logs use DynamoDB's `list_append` operation to efficiently append entries to a daily bucket. This means:

- **No read-before-write** — entries are appended atomically
- **Daily buckets** — one item per handler per day, keeping item sizes manageable
- **Auto-cleanup** — 7-day TTL ensures old logs are automatically deleted
- **No cold start penalty** — the platform client uses lazy SDK initialization

## Querying Logs

You can query the platform table directly using the AWS CLI or SDK:

```bash
# Get today's execution log for a handler
aws dynamodb get-item \
  --table-name my-project-dev-platform \
  --key '{"pk": {"S": "HANDLER#createOrder"}, "sk": {"S": "EXEC#2026-02-09"}}'

# Get all logs for a handler (all days)
aws dynamodb query \
  --table-name my-project-dev-platform \
  --key-condition-expression "pk = :pk AND begins_with(sk, :sk)" \
  --expression-attribute-values '{":pk": {"S": "HANDLER#createOrder"}, ":sk": {"S": "EXEC#"}}'
```

## Architecture

```
runtime/
├── handler-utils.ts      # createHandlerRuntime() — shared init + logging
├── platform-client.ts    # DynamoDB operations (appendExecution, appendError)
└── platform-types.ts     # Entity types, TTL computation, truncation
```

The `createHandlerRuntime()` function in `handler-utils.ts` provides each wrapper with:

- **`logExecution(startTime, input, output)`** — fire-and-forget success log
- **`logError(startTime, input, error)`** — fire-and-forget error log
- **`commonArgs()`** — resolves ctx, deps, params (cached per cold start)

Both `wrap-http.ts` and `wrap-table-stream.ts` use this shared runtime, so observability behavior is consistent across all handler types.
