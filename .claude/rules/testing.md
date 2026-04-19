---
paths:
  - "**/test/**"
  - "**/*.test.ts"
---

## Test conventions

- **Framework**: Vitest (`import { describe, it, expect, vi } from "vitest"`)
- **File naming**: `*.test.ts` in `packages/<pkg>/test/`
- **Structure**: nested `describe`/`it` blocks, grouped by feature
- **Import alias**: `~aws/*` maps to `src/*` in effortless-aws package, `~cli/*` maps to `src/*` in CLI package

## AWS SDK mocking

Mock declarations MUST come before imports of code under test:

```typescript
const mockPutItem = vi.fn()
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class { putItem = mockPutItem },
}))

// Import AFTER mock setup
import { createTableClient } from "~aws/runtime/table-client"
```

Clear mocks in `beforeEach`:
```typescript
beforeEach(() => { vi.clearAllMocks() })
```

## Environment variables

Save and restore `process.env`:
```typescript
const originalEnv = process.env
afterEach(() => { process.env = originalEnv })
```

## Type inference tests

Use compile-time assertions, no runtime checks needed:

```typescript
type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

it("deps are typed in handler", () => {
  defineWorker<Job>()
    .deps(() => ({ ordersTable }))
    .onMessage(async (msg, { deps }) => {
      type _orders = Expect<Equal<typeof deps.ordersTable, TableClient<Order>>>
    })
})
```

## AST extraction tests (CLI package)

Use helpers from `test/helpers/extract-from-source.ts`:

```typescript
import { extractApiConfigs } from "./helpers/extract-from-source"

it("should extract basePath", async () => {
  const configs = await extractApiConfigs(`
    import { defineApi } from "effortless-aws"
    export default defineApi({ basePath: "/api" })
      .get("/users", async () => ({ status: 200 }))
  `)
  expect(configs[0]!.config).toEqual({ basePath: "/api" })
})
```

## Bundle tests (CLI package)

Use `importBundle` from `test/helpers/bundle-code.ts`:

```typescript
import { importBundle } from "./helpers/bundle-code"

it("should route requests", async () => {
  const mod = await importBundle({ code: handlerCode, projectDir, type: "api" })
  const res = await mod.handler(makeEvent("GET", "/api/users"))
  expect(res.statusCode).toBe(200)
})
```

## Coverage by handler type

| Handler | Unit tests | Type tests | Extraction tests |
|---------|-----------|------------|-----------------|
| `defineTable` | table-client ops, stream wrapping | deps/config inference | config extraction |
| `defineApi` | routing, body parsing, auth | route handler args | basePath, routes |
| `defineBucket` | event wrapping | deps inference | prefix/suffix config |
| `defineQueue` | message parsing, batching | message type inference | batch config |
| `defineWorker` | message handling | message type inference | size/timeout config |
| `defineCron` | tick wrapping | setup inference | schedule extraction |
| `defineMailer` | email client | — | — |
| `defineStaticSite` | middleware wrapping | — | site config |
