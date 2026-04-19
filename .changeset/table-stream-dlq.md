---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Fix silent failures in DynamoDB table stream handlers and split stream options into a dedicated `.stream()` builder method.

**Previously** table stream errors were silently swallowed: the runtime returned `batchItemFailures` but the event source mapping was created without `FunctionResponseTypes: ["ReportBatchItemFailures"]`, so AWS ignored the response, there was no retry, and no DLQ.

**Now**:
- Event source mapping sets `FunctionResponseTypes: ["ReportBatchItemFailures"]`, `BisectBatchOnFunctionError: true`, `MaximumRetryAttempts` (from `maxRetries`, default 1) and an `OnFailure` destination.
- Every table with a stream handler gets a standard SQS DLQ `{project}-{stage}-{handler}-dlq`, created automatically and cleaned up on teardown.
- Failed records are retried with AWS's built-in exponential backoff; once retries are exhausted AWS sends a pointer to the failed record into the DLQ.

**Breaking**: stream-related options moved out of `defineTable({...})` into a new `.stream({...})` builder method. Affected options: `batchSize`, `batchWindow`, `concurrency`, `startingPosition`, `streamView`.

Migration:

```ts
// before
export const orders = defineTable<Order>({
  batchSize: 10,
  concurrency: 5,
  streamView: "NEW_AND_OLD_IMAGES",
})
  .onRecord(async ({ record }) => { ... })

// after
export const orders = defineTable<Order>()
  .stream({
    batchSize: 10,
    concurrency: 5,
    maxRetries: 1,
    streamView: "NEW_AND_OLD_IMAGES",
  })
  .onRecord(async ({ record }) => { ... })
```
