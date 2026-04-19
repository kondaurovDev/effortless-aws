---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Rename `defineFifoQueue` → `defineQueue` with `fifo` as a queue option, and move event-source-mapping settings into a dedicated `.poller({...})` builder method.

**Rationale**: the new shape prepares the ground for standard (non-FIFO) queue support and cleanly separates queue-resource properties from poller/ESM properties (which in AWS live on a different resource — the Event Source Mapping).

**Breaking — no compatibility alias**:

- `defineFifoQueue(...)` → `defineQueue({ fifo: true, ... })`
- Top-level `batchSize`/`batchWindow` options move into `.poller({ batchSize, batchWindow })`, called before the terminal `.onMessage` / `.onMessageBatch`
- Exported types renamed: `FifoQueueHandler` → `QueueHandler`, `FifoQueueMessage` → `QueueMessage`, `FifoQueueConfig` → `QueueConfig`; new `QueuePollerConfig` exported
- Handler brand changed from `"effortless-fifo-queue"` to `"effortless-queue"`

Migration:

```ts
// before
export const orderQueue = defineFifoQueue<Order>({ batchSize: 5 })
  .onMessage(async ({ message }) => { ... })

// after
export const orderQueue = defineQueue<Order>({ fifo: true })
  .poller({ batchSize: 5 })
  .onMessage(async ({ message }) => { ... })
```

Only `fifo: true` is currently supported; standard-queue semantics (including the typed client `.send()` signature without `messageGroupId`) will arrive in a follow-up release.
