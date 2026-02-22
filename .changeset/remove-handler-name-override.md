---
"effortless-aws": minor
---

- Add `defineBucket` with S3 event notifications (`onObjectCreated`/`onObjectRemoved`)
- Add `BucketClient` (`get`/`put`/`delete`/`list`) for S3 operations
- Support bucket as dep type — typed `BucketClient` injection via `deps: { uploads }`
- Unify `SetupFactory` to always-args pattern across `defineHttp`/`defineFifoQueue` (consistent with `defineTable`/`defineBucket`)
- Remove `name` option from handler config — resource names are now always derived from the export name
