---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

refactor: deps is now always a function, rename typed to unsafeAs

**Breaking changes:**

- `deps` must be declared as a function: `deps: () => ({ orders })` (object shorthand `deps: { orders }` is no longer supported)
- `typed<T>()` helper removed — use `unsafeAs<T>()` instead

**Improvements:**

- `unsafeAs<T>()` replaces `typed<T>()` with a clearer name signaling no runtime validation
- Handler type annotations (`TableHandler`, `FifoQueueHandler`, `BucketHandler`) now accept any `setup` return type without needing explicit generics
- Simplified internal type exports — removed unused callback/options types from public API
- CLI handler registry updated to parse arrow-function deps syntax
