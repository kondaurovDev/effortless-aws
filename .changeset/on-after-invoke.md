---
"effortless-aws": minor
---

feat: add `onAfterInvoke` lifecycle hook for all handler types

New optional callback executed after each Lambda invocation completes, right before the process freezes. Useful for flushing batched logs/metrics, checking buffers, or any cleanup that needs CPU time before Lambda suspends the execution environment.

Supported on: `defineApi`, `defineTable`, `defineFifoQueue`, `defineBucket`.

```typescript
export default defineApi({
  basePath: "/api",
  onAfterInvoke: async ({ ctx, deps }) => {
    if (buffer.length >= 100) await flush();
  },
  // ...
});
```
