---
paths:
  - "packages/effortless-aws/src/index.ts"
  - "packages/effortless-aws/src/handlers/**"
---

## Public API rules

1. **Only export types users need directly.** Do NOT export internal types:
   - Callback function types (e.g. `TableRecordFn`, `BucketEventFn`)
   - Internal options types (e.g. `DefineTableOptions`, `DefineBucketOptions`)
   - Utility/resolution types (e.g. `ResolveDeps`, `ResolveConfig`, `AnyParamRef`)

2. **Handler return types must not leak internal generics.** Types like `TableHandler`, `FifoQueueHandler`, `ApiHandler` etc. should only carry generics needed externally (e.g. `T` for schema). Internal generics (`D`, `P`, `S` for deps/config/static) must stay local to the `define*` function.

3. **No Effect types in public API.** The public API must be framework-agnostic. Effect types (`Effect`, `Layer`, `Context`, `Schema`) must never appear in exported type signatures.
