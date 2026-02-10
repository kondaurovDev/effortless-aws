# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    User's Project                       │
│                                                         │
│  effortless.config.ts                                   │
│  src/                                                   │
│    ├── expenses.ts    → export processExpenses = ...    │
│    ├── api.ts         → export getUsers = ...           │
│    └── jobs.ts        → export dailyReport = ...        │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  effortless-aws CLI                  │
│                                                         │
│  1. Load config (effortless.config.ts)                  │
│  2. Analyze handlers (ts-morph)                         │
│     - Find all defineQueue/defineHttp/etc exports               │
│     - Extract metadata from handler configs             │
│  3. Bundle each handler (esbuild)                       │
│     - Tree-shake, minify                                │
│     - Output: dist/<handler-name>/index.js              │
│  4. Deploy to AWS (SDK direct calls)                    │
│     - Create/update IAM roles                           │
│     - Create/update Lambda functions                    │
│     - Create/update triggers (SQS, API GW, etc)         │
│     - Wire everything together                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                        AWS                              │
│                                                         │
│  Lambda: my-service-dev-processExpenses                 │
│    ← SQS: my-service-dev-expenses                       │
│                                                         │
│  Lambda: my-service-dev-getUsers                        │
│    ← API Gateway: my-service-dev-api                    │
│       Route: GET /api/users                             │
│                                                         │
│  Lambda: my-service-dev-dailyReport                     │
│    ← EventBridge: my-service-dev-dailyReport-schedule   │
│                                                         │
│  Lambda: my-service-dev-orders                          │
│    ← DynamoDB Stream: my-service-dev-orders             │
└─────────────────────────────────────────────────────────┘
```

## Package Structure

```
effortless-aws/
├── src/
│   │
│   ├── aws/                    # AWS operations (3 layers)
│   │   │
│   │   ├── clients/            # Layer 1: Low-level SDK wrappers (generated)
│   │   │   ├── lambda.ts       #   Effect-wrapped AWS SDK calls
│   │   │   ├── iam.ts          #   Typed errors, service contexts
│   │   │   ├── dynamodb.ts
│   │   │   ├── apigatewayv2.ts
│   │   │   ├── resource-groups-tagging-api.ts
│   │   │   └── index.ts        #   makeClients() layer factory
│   │   │
│   │   ├── lambda.ts           # Layer 2: Resource operations
│   │   ├── iam.ts              #   ensureLambda, ensureRole, ensureTable...
│   │   ├── dynamodb.ts         #   Create/update/delete with retry logic
│   │   ├── apigateway.ts       #   Idempotent operations
│   │   ├── layer.ts            #   Lambda layer management
│   │   ├── tags.ts             #   Resource tagging & discovery
│   │   └── index.ts
│   │
│   ├── build/                  # Build phase
│   │   ├── handler-registry.ts #   Handler type definitions (http, table)
│   │   ├── bundle.ts           #   esbuild bundling, code transformation
│   │   └── index.ts
│   │
│   ├── deploy/                 # Layer 3: Deployment orchestration
│   │   ├── shared.ts           #   Common types, deployCoreLambda
│   │   ├── deploy-http.ts      #   HTTP handler deployment
│   │   ├── deploy-table.ts     #   DynamoDB table + stream deployment
│   │   ├── deploy.ts           #   Pattern-based deployment (deployFromPatterns)
│   │   ├── cleanup.ts          #   Resource deletion
│   │   └── index.ts
│   │
│   ├── handlers/               # User-facing handler definitions
│   │   ├── define-http.ts      #   defineHttp() + types
│   │   ├── define-table.ts     #   defineTable() + types
│   │   ├── param.ts            #   param() helper + ParamRef/ResolveParams types
│   │   ├── permissions.ts      #   IAM permission types
│   │   └── index.ts
│   │
│   ├── runtime/                # Lambda runtime wrappers (bundled into handlers)
│   │   ├── wrap-http.ts        #   Parses API GW event, calls handler, formats response
│   │   ├── wrap-table-stream.ts#   Parses DynamoDB stream event, calls onRecord/onBatch
│   │   ├── handler-utils.ts    #   Shared: buildDeps(), buildParams()
│   │   ├── ssm-client.ts       #   SSM GetParameters with lazy init, auto-chunking
│   │   └── table-client.ts     #   TableClient<T> — typed DynamoDB CRUD client
│   │
│   ├── cli/                    # CLI implementation
│   │   ├── commands/
│   │   │   ├── deploy.ts       #   eff deploy
│   │   │   ├── build.ts        #   eff build
│   │   │   ├── status.ts       #   eff status
│   │   │   ├── cleanup.ts      #   eff cleanup
│   │   │   └── layers.ts       #   eff layers
│   │   ├── config.ts           #   Config loading, CLI options
│   │   ├── cleanup.ts          #   Legacy cleanup (tag-based)
│   │   └── index.ts            #   CLI entry point
│   │
│   ├── config.ts               # defineConfig() + EffortlessConfig type
│   └── index.ts                # Public exports
│
└── package.json
```

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI (eff)                           │
│  deploy, build, status, cleanup, layers                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    deploy/ (Orchestration)                  │
│                                                             │
│  deployFromPatterns() ─┬─► deployLambda() ──► addRouteToApi │
│                        └─► deployTableFunction()            │
│                                                             │
│  Responsibilities:                                          │
│  - Discover handlers in files                               │
│  - Coordinate build + deploy                                │
│  - Wire up triggers (API GW routes, DynamoDB streams)       │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  build/         │  │  aws/           │  │  handlers/      │
│  (Build Phase)  │  │  (AWS Ops)      │  │  (Definitions)  │
│                 │  │                 │  │                 │
│  bundle()       │  │  ensureLambda() │  │  defineHttp()   │
│  zip()          │  │  ensureRole()   │  │  defineTable()  │
│  transform()    │  │  ensureTable()  │  │                 │
│  extractConfig()│  │  ensureLayer()  │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   aws/clients/ (SDK Layer)                  │
│                                                             │
│  lambda.make("create_function", {...})                      │
│  iam.make("create_role", {...})                             │
│  dynamodb.make("create_table", {...})                       │
│                                                             │
│  - Generated Effect wrappers                                │
│  - Typed errors (LambdaError, IAMError, etc.)               │
│  - Service contexts via makeClients()                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        AWS SDK                              │
└─────────────────────────────────────────────────────────────┘
```

## Build Pipeline

The build system has two phases: **static analysis** (ts-morph) and **bundling** (esbuild). They solve different problems and operate on different parts of the handler definition.

### What the user writes

```typescript
// src/api.ts
export const createUser = defineHttp({
  method: "POST",           // ← static config (extracted by ts-morph)
  path: "/users",           // ← static config
  memory: 512,              // ← static config
  schema: S.decodeUnknownSync(UserSchema),  // ← runtime (bundled by esbuild)
  onError: (err, req) => ({ ... }),         // ← runtime
  context: () => ({ db }),                  // ← runtime
  onRequest: async ({ data, ctx }) => ...,  // ← runtime
});
```

### Phase 1: Static analysis (ts-morph)

`extractHandlerConfigs()` parses the source code as AST and extracts only the serializable config properties (method, path, memory, timeout, permissions). Runtime properties (functions, closures) are stripped via the `RUNTIME_PROPS` list.

```
RUNTIME_PROPS = ["onRequest", "onRecord", "onBatch", "onBatchComplete",
                 "context", "schema", "onError", "deps", "params"]
```

This static config is used by the **deploy phase** to configure AWS resources (API Gateway routes, Lambda memory/timeout, etc.) without needing to execute user code.

```
Source code  →  ts-morph AST  →  { method: "POST", path: "/users", memory: 512 }
                                   (no functions, safe to serialize)
```

### Phase 2: Bundling (esbuild)

`bundle()` creates a **virtual entry point** that imports the user's handler and wraps it with the framework's runtime wrapper. This entry point is never written to disk — it's passed to esbuild via `stdin.contents`.

```
┌─ Virtual entry point (generated in memory) ──────────────────────┐
│                                                                   │
│  import { createUser } from "/abs/path/to/src/api.ts";           │
│  import { wrapHttp } from "/abs/path/to/dist/runtime/wrap-http"; │
│  export const handler = wrapHttp(createUser);                    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   User's handler code           Framework runtime wrapper
   (defineHttp + onRequest       (wrapHttp: parses Lambda event,
    + schema + context)           validates schema, calls handler,
                                  formats response)
         │                              │
         └──────────┬───────────────────┘
                    ▼
              esbuild bundle
                    │
                    ▼
         Single JS file for Lambda
```

### Path resolution trick

The handler registry defines wrapper paths with a `~/runtime/` prefix:

```typescript
handlerRegistry = {
  http: {
    wrapperFn: "wrapHttp",
    wrapperPath: "~/runtime/wrap-http",  // placeholder prefix
  },
}
```

At bundle time, `~/runtime` is replaced with the **absolute path** to the package's compiled runtime directory (`dist/runtime/`). This is resolved from the package's own location via `import.meta.url`:

```typescript
const runtimeDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/runtime"
);
```

This way esbuild can resolve imports from two different locations in a single bundle:
- **User code**: resolved from `resolveDir` (user's project root)
- **Runtime wrappers**: resolved from absolute path to the framework's `dist/`

### Full flow

```
User code                    Build system                      Output
─────────                    ────────────                      ──────

defineHttp({          ┌─► ts-morph extracts static config ─► deploy phase
  method: "POST",     │      { method, path, memory }        (API GW, Lambda)
  path: "/users",     │
  schema: ...,        │
  onRequest: ...,  ───┤
})                    │
                      └─► esbuild bundles everything ──────► index.mjs
                           (handler + wrapper + deps)         (uploaded to Lambda)
```

## Resource Discovery

The CLI finds existing resources via AWS tags (no local state files). Every deployed resource is tagged:

```
effortless:project = my-service
effortless:stage = dev
effortless:handler = processExpenses
effortless:type = lambda | sqs | dynamodb | ...
```

### Deploy Algorithm

```
deploy:
  query AWS by tags → get current state
  compare with handlers in code
  create/update changed resources
  tag new resources

deploy --force:
  query AWS by tags
  compare with current handlers
  delete orphaned resources (no matching handler)

destroy:
  query AWS by tags
  delete all resources for this project/stage
```

## Stage Isolation

Each stage (`dev`, `staging`, `prod`, etc.) is a **fully independent set of AWS resources** with no shared infrastructure between stages. This is a deliberate design decision.

```
eff deploy --stage dev       eff deploy --stage prod
         │                            │
         ▼                            ▼
┌──────────────────────┐   ┌──────────────────────┐
│  my-app-dev          │   │  my-app-prod         │
│                      │   │                      │
│  API Gateway         │   │  API Gateway         │
│  Lambda functions    │   │  Lambda functions     │
│  DynamoDB tables     │   │  DynamoDB tables      │
│  IAM roles           │   │  IAM roles            │
│  Lambda layer        │   │  Lambda layer         │
│  Platform table      │   │  Platform table       │
└──────────────────────┘   └──────────────────────┘
       (isolated)                 (isolated)
```

### Why not a shared API Gateway with multiple stages?

AWS API Gateway V2 (HTTP API) supports built-in stages, which might seem like a natural way to separate environments. However, sharing an API Gateway across stages has significant drawbacks:

- **Blast radius** — a misconfigured route or a broken deployment on `dev` can affect `prod` if they share the same API Gateway resource.
- **Throttling and rate limits** — API Gateway limits (requests per second, burst) are shared across all stages of the same API. A load test on `dev` could throttle `prod` traffic.
- **Stage variables in HTTP API** — API Gateway V2 does not support stage variables in Lambda integrations, so there's no clean way to route the same path to different Lambda functions per stage.
- **Independent lifecycle** — separate resources can be created, updated, and destroyed independently. Destroying `dev` never risks touching `prod`.

### Naming convention

All resources include both the project name and stage in their identifiers, ensuring no collisions:

| Resource | Naming pattern |
|---|---|
| Lambda function | `${project}-${stage}-${handler}` |
| IAM role | `${project}-${stage}-${handler}-role` |
| API Gateway | `${project}-${stage}` |
| DynamoDB table | `${project}-${stage}-${handler}` |
| Platform table | `${project}-${stage}-platform` |
| Lambda layer | `${project}-${stage}-deps` |

---

## Inter-Handler Dependencies (`deps`)

Handlers can declare dependencies on other handlers. The framework auto-wires environment variables, IAM permissions, and provides typed runtime clients.

### User API

```typescript
// src/orders.ts
export const orders = defineTable<Order>({
  pk: { name: "orderId", type: "string" },
  onRecord: async ({ record }) => { ... },
});

// src/api.ts
import { orders } from "./orders.js";

export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ req, deps }) => {
    await deps.orders.put({ orderId: "abc-123", amount: 99 });
    const item = await deps.orders.get({ orderId: "abc-123" });
    return { status: 201, body: item };
  },
});
```

The `deps` property accepts an object of handler references. TypeScript infers the correct `TableClient<T>` type for each dependency based on the table's generic parameter.

### Type System

```
ResolveDeps<D>
  Maps { key: TableHandler<T, ...> } → { key: TableClient<T> }

TableClient<T>
  ├── put(item: T): Promise<void>
  ├── get(key: Partial<T>): Promise<T | undefined>
  ├── delete(key: Partial<T>): Promise<void>
  ├── query(params): Promise<T[]>
  └── tableName: string
```

Both `defineHttp` and `defineTable` accept a `D` generic parameter for deps. The callback args use conditional types so that `deps` only appears when `D` is not `undefined`:

```typescript
& ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
```

### Pipeline

The deps feature touches all three phases: build, deploy, and runtime.

```
Build (ts-morph)          Deploy (Effect)              Runtime (Lambda)
────────────────          ─────────────────            ──────────────────

extractDepsKeys()    →    buildTableNameMap()     →    buildDeps(handler)
reads AST to get          maps handler names to        reads EFF_TABLE_<key>
dep keys: ["orders"]      table names:                 env vars, creates
                          orders → proj-stg-orders     TableClient instances

                          resolveDeps()
                          generates env vars:
                          EFF_TABLE_orders=proj-stg-orders
                          + DynamoDB IAM permissions
```

#### Build phase

`extractDepsKeys()` in `handler-registry.ts` reads the `deps` property from the handler config AST. It handles:
- Shorthand: `deps: { orders }` → reads `ShorthandPropertyAssignment` names
- Explicit: `deps: { orders: orders }` → reads `PropertyAssignment` names

The `deps` property itself is in `RUNTIME_PROPS` (not serializable), so it's stripped from the static config. Only the extracted key names (`depsKeys: string[]`) are passed to the deploy phase.

#### Deploy phase

1. **`buildTableNameMap()`** — builds a `Map<string, string>` of all table handler export names to their deterministic DynamoDB table names (`${project}-${stage}-${handlerName}`)

2. **`resolveDeps(depsKeys, tableNameMap)`** — for each dep key:
   - Looks up the table name from the map
   - Sets env var: `EFF_TABLE_<key> = <tableName>`
   - Collects DynamoDB IAM permissions (`GetItem`, `PutItem`, `DeleteItem`, `Query`, `Scan`, `UpdateItem`, `BatchWriteItem`)
   - Returns `{ env, permissions }` which are threaded to `deployCoreLambda()`

3. **`ensureLambda()`** — accepts `environment?: Record<string, string>` to set Lambda environment variables. Detects env changes and updates configuration when needed.

#### Runtime phase

`buildDeps()` in `handler-utils.ts` (shared by both wrappers):

1. Reads `Object.keys(handler.deps)` to find dep names
2. For each key, reads `process.env[EFF_TABLE_${key}]`
3. Calls `createTableClient(tableName)` — creates a typed DynamoDB client with lazy SDK initialization
4. Injects the resulting `deps` object into the handler callback args

The `TableClient` uses the same lazy init pattern as the rest of the runtime: the DynamoDB SDK client is created once on the first call, then reused across invocations (Lambda container reuse).

```
Lambda cold start:
  handler.deps = { orders: TableHandler }     (from define-time)
  process.env.EFF_TABLE_orders = "proj-stg-orders"  (from deploy)
       │
       ▼
  buildDeps(handler)
       │
       ▼
  { orders: TableClient("proj-stg-orders") }  (injected into args.deps)
       │
       ▼
  deps.orders.put({ orderId: "abc", ... })     (user code)
       │
       ▼
  DynamoDB.putItem({ TableName: "proj-stg-orders", Item: ... })
```

### Table Self-Client (`table` arg)

Table handlers that process stream events often need to write back to their own table. A circular `deps` reference is impossible (`deps: { self: ExpenseTable }` — `ExpenseTable` isn't defined yet), so every table handler callback automatically receives a `table: TableClient<T>` argument — a typed client for its own table.

```typescript
export const orders = defineTable<Order>({
  pk: { name: "orderId", type: "string" },
  onRecord: async ({ record, table }) => {
    await table.put({ orderId: record.new!.orderId, status: "processed" });
  }
});
```

The `table` arg is always present in `onRecord`, `onBatch`, and `onBatchComplete` — no configuration needed.

**How it works:**

1. **Deploy**: `deploy-table.ts` sets `EFF_TABLE_SELF=<tableName>` on the Lambda environment (merged into the same `depsEnv` mechanism)
2. **Runtime**: `wrap-table-stream.ts` reads `process.env.EFF_TABLE_SELF`, creates a `TableClient` via `createTableClient()`, and injects it as `table` in callback args
3. **Lazy init**: same pattern as `deps` — the client is created once on first invocation and reused

---

## SSM Parameters (`params`)

Handlers can declare SSM Parameter Store values that are automatically fetched, cached, and injected at runtime. The framework handles IAM permissions, environment variable wiring, and batch fetching — following the same build/deploy/runtime pipeline as `deps`.

### User API

```typescript
import { defineHttp, param } from "effortless-aws";
import TOML from "smol-toml";

export const api = defineHttp({
  method: "GET",
  path: "/orders",
  params: {
    dbUrl: param("database-url"),                    // → string
    config: param("app-config", TOML.parse),         // → ReturnType<typeof TOML.parse>
  },
  context: async ({ params }) => ({
    pool: createPool(params.dbUrl),
  }),
  onRequest: async ({ req, ctx, params }) => {
    // params.dbUrl    — string from SSM
    // params.config   — parsed TOML object
    // ctx.pool        — created with SSM value
  },
});
```

### Key design decisions

- **No secrets in env vars** — only SSM paths (e.g. `/${project}/${stage}/${key}`) are stored as Lambda environment variables. Actual values are fetched at runtime via `GetParameters`.
- **Agnostic transforms** — `param(key, transform)` accepts any `(raw: string) => T` function. No built-in parsers — users bring their own (JSON.parse, TOML.parse, etc.).
- **Cold start caching** — SSM values are fetched once per Lambda cold start and cached in a closure. Subsequent invocations reuse cached values.
- **Batch fetching** — uses `GetParameters` (not `GetParameter`) from the start. Auto-chunks into batches of 10 (SSM API limit).
- **`WithDecryption: true`** — always enabled, so `SecureString` parameters work transparently.

### Type System

```
ParamRef<T = string>
  Branded type returned by param(). T defaults to string,
  inferred from transform: param("key", JSON.parse) → ParamRef<any>

ResolveParams<P>
  Maps { key: ParamRef<T> } → { key: T }
  e.g. { dbUrl: ParamRef<string>, config: ParamRef<TomlDoc> }
     → { dbUrl: string, config: TomlDoc }
```

The `P` generic uses the same conditional pattern as `D` (deps):

```typescript
& ([P] extends [undefined] ? {} : { params: ResolveParams<P> })
```

Context factory type is conditional on `P`:

```typescript
type ContextFactory<C, P> =
  [P] extends [undefined]
    ? () => C | Promise<C>                              // no params
    : (args: { params: ResolveParams<P> }) => C | Promise<C>  // with params
```

### Pipeline

```
Build (ts-morph)            Deploy (Effect)                Runtime (Lambda)
────────────────            ─────────────────              ──────────────────

extractParamEntries()  →    resolveParams()           →    buildParams(handler)
reads param("key")          generates env vars:            reads EFF_PARAM_<prop>
calls from AST              EFF_PARAM_dbUrl=               env vars, batch-fetches
→ [{propName, ssmKey}]      /proj/stg/database-url         SSM, applies transforms
                            + SSM IAM permissions
                                                           mergeResolved()
                            mergeResolved()                 combines deps + params
                            combines deps + params          into single env/perms
                            env/perms for Lambda
```

#### Build phase

`extractParamEntries()` in `handler-registry.ts` reads the `params` property from the handler config AST. For each property, it finds a `CallExpression` to `param()` and extracts the first `StringLiteral` argument as the SSM key.

```typescript
params: {
  dbUrl: param("database-url"),        // → { propName: "dbUrl", ssmKey: "database-url" }
  config: param("app-config", fn),     // → { propName: "config", ssmKey: "app-config" }
}
```

The `params` property is in `RUNTIME_PROPS`, so it's stripped from static config. Only `paramEntries: ParamEntry[]` is passed to deploy.

#### Deploy phase

1. **`resolveParams(paramEntries, project, stage)`** — for each param entry:
   - Sets env var: `EFF_PARAM_<propName> = /${project}/${stage}/${ssmKey}`
   - Collects SSM IAM permissions (`ssm:GetParameter`, `ssm:GetParameters`)

2. **`mergeResolved(deps, params)`** — combines deps and params env/permissions into a single payload passed to `deployCoreLambda()`. This avoids changes to the core deploy types.

#### Runtime phase

`buildParams()` in `handler-utils.ts`:

1. Reads `EFF_PARAM_*` environment variables to get SSM paths
2. Batch-fetches all values via `getParameters()` from `ssm-client.ts`
3. Applies transform functions from `handler.params[key].transform` if present
4. Returns resolved params object, cached in closure for subsequent invocations

```
Lambda cold start:
  handler.params = { dbUrl: ParamRef }              (from define-time)
  process.env.EFF_PARAM_dbUrl = "/proj/stg/db-url"  (from deploy)
       │
       ▼
  buildParams(handler.params)
       │
       ▼
  SSM.getParameters(["/proj/stg/db-url"])            (batch fetch, once)
       │
       ▼
  { dbUrl: "postgres://..." }                        (cached in closure)
       │
       ▼
  params.dbUrl                                       (injected into args)
```

Context factory receives params before handler invocation, enabling DI patterns:

```typescript
context: async ({ params }) => ({
  pool: createPool(params.dbUrl),  // pool created once per cold start
})
```

---

## Lambda Layer (Production Dependencies)

The framework automatically creates a shared Lambda Layer containing all production dependencies from `package.json`. Handler code is bundled by esbuild with these dependencies marked as `external` — at runtime they're loaded from the layer at `/opt/nodejs/node_modules/`.

### Package Manager Support

The layer builder works with **any package manager** that produces a `node_modules` directory:

| Package Manager | Supported | How it works |
|---|---|---|
| **npm** | Yes | Flat hoisted `node_modules/`, all packages at root level |
| **yarn classic (v1)** | Yes | Same hoisted structure as npm |
| **yarn berry + `nodeLinker: node-modules`** | Yes | Generates standard `node_modules/` |
| **pnpm** | Yes | Follows symlinks via `realpathSync`, falls back to scanning `.pnpm/` store |

> **Note:** Yarn Berry with Plug'n'Play (PnP) mode is not supported — it doesn't produce a `node_modules` directory.

### How It Works

The layer builder uses a two-phase approach: **recursive collection** and **completeness verification**.

```
package.json (dependencies)
     │
     ▼
Phase 1: collectTransitiveDeps()
     Recursively walks package.json → dependencies / optionalDependencies / peerDependencies
     For pnpm: follows symlinks inside .pnpm/pkg@version/node_modules/
     Fallbacks: searchPath → root node_modules → .pnpm store scan
     │
     ▼
Phase 2: verify completeness
     For every collected package, checks that ALL its declared deps are also collected.
     Auto-adds any missing packages. Loops until no new packages are discovered.
     │
     ▼
createLayerZip()
     Packs all packages into nodejs/node_modules/{name}/ structure
     Deterministic zip (fixed dates) → same content = same hash
     │
     ▼
ensureLayer()
     Hash-based versioning: only publishes a new layer version when deps change
     Reuses existing layer if hash matches
```

#### Phase 1: Recursive collection

Starting from direct `dependencies` in the project's `package.json`, the builder walks the dependency tree by reading each package's own `package.json`:

```
googleapis
  → google-auth-library     (declared in googleapis/package.json)
    → gaxios                 (declared in google-auth-library/package.json)
      → node-fetch           (declared in gaxios/package.json)
        → whatwg-url          (declared in node-fetch/package.json)
```

For **pnpm**, each recursive step resolves through the `.pnpm` store structure:
1. Find package in current `searchPath` (e.g., `.pnpm/googleapis@140.0.0/node_modules/`)
2. `realpathSync` to resolve symlinks to actual package location
3. Fall back to root `node_modules/` (for hoisted deps)
4. Fall back to scanning `.pnpm/` directory entries

#### Phase 2: Completeness verification

After collection, a verification loop acts as a safety net. For every package in the set, it checks that all declared dependencies are also present. If a transitive dep was missed (e.g., due to a broken symlink or pnpm edge case), it's **automatically added** and a warning is logged:

```
⚠ [layer] Auto-added missing transitive dep: "whatwg-url" (required by "node-fetch")
```

This eliminates the class of runtime errors like `Cannot find module 'whatwg-url'` — if a package declares a dependency, it will be in the layer.

### Warnings

All layer operations produce visible warnings instead of silently swallowing errors:

- **Package not found**: `Package "foo" not found (searched: ...) — entire subtree skipped`
- **Auto-added deps**: `Auto-added missing transitive dep: "bar" (required by "foo")`
- **Symlink failures**: `realpathSync failed for "foo" at /path: ENOENT`
- **Skipped packages**: `Skipped N packages (not found): ...`

### Layer Reuse

Layers are versioned by a SHA-256 hash of all `package@version` pairs. If the hash matches an existing published layer version, it's reused — no re-upload needed. This makes deploys fast when only handler code changes.

```
Layer name:    ${project}-${stage}-deps
Description:   effortless deps layer hash:abc12345
```

### AWS SDK Handling

AWS SDK v3 packages (`@aws-sdk/*`, `@smithy/*`) are **always excluded** from both the layer and the handler bundle. They're provided by the Lambda Node.js runtime, which keeps the layer size small and avoids version conflicts.

---

## Prior Art

- [Firebase Functions](https://firebase.google.com/docs/functions) - inspiration for DX
- [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) - inspiration for runtime best practices (batch processing, idempotency, structured logging, metrics, tracing)
- [SST](https://sst.dev/) - infrastructure from code for AWS
- [Nitric](https://nitric.io/) - cloud-agnostic declarative framework
- [Pulumi](https://www.pulumi.com/) - infrastructure as code
