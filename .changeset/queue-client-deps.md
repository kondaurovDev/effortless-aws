---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

feat: QueueClient — FIFO queues as deps for typed message sending

- `QueueClient<T>` with `send()` and `sendBatch()` methods
- FIFO queue handlers can now be used in `deps: { myQueue }` declarations
- `ResolveDeps` maps `FifoQueueHandler<T>` to `QueueClient<T>` with full type inference
- Deploy resolves queue deps to `EFF_DEP_<key>=queue:<name>` env vars with SQS IAM permissions
- Runtime lazily resolves queue URL via `getQueueUrl` (cached after first call)
- Deploy now applies `delay` (DelaySeconds) when creating/updating FIFO queues
