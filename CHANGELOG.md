# effortless-aws

## 0.1.0

### Minor Changes

- [#2](https://github.com/kondaurovDev/effortless-aws/pull/2) [`bcc3723`](https://github.com/kondaurovDev/effortless-aws/commit/bcc37235730a953f4d0f18dfcd9403c847b91fff) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add onBatch stream processing, cross-handler deps, SSM params, and typed TableClient

  - **onBatch / onBatchComplete** — new stream processing modes for `defineTable` alongside per-record `onRecord`
  - **deps** — declare `deps: { orders }` to get a typed `TableClient` injected with auto-wired IAM permissions
  - **params** — `param("key")` fetches SSM Parameter Store values at cold start with optional transforms
  - **TableClient** — typed `put`, `get`, `delete`, `query` with lazy DynamoDB SDK initialization
  - **README** — project overview with examples and comparison table

## 0.0.2

### Patch Changes

- [`4608edb`](https://github.com/kondaurovDev/effortless-aws/commit/4608edbc389246404f2f4052fbd0ce961cd21f59) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Restructure project from monorepo to single package
