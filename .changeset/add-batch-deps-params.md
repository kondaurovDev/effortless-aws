---
"effortless-aws": minor
---

Add onBatch stream processing, cross-handler deps, SSM params, and typed TableClient

- **onBatch / onBatchComplete** — new stream processing modes for `defineTable` alongside per-record `onRecord`
- **deps** — declare `deps: { orders }` to get a typed `TableClient` injected with auto-wired IAM permissions
- **params** — `param("key")` fetches SSM Parameter Store values at cold start with optional transforms
- **TableClient** — typed `put`, `get`, `delete`, `query` with lazy DynamoDB SDK initialization
- **README** — project overview with examples and comparison table
