---
"effortless-aws": minor
---

Add ctx/deps/config/files to onError callbacks in defineTable, defineFifoQueue, defineBucket, and defineApi. Extract shared `HandlerArgs` utility type to reduce duplication across callback types.

**Breaking**: `onError` now receives a single object argument instead of positional args.

Before: `onError: (error) => { ... }`
After:  `onError: ({ error }) => { ... }`

For defineApi, `req` is also included: `onError: ({ error, req }) => { ... }`
