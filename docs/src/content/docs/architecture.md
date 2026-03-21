---
title: Architecture
description: How effortless works under the hood — build pipeline, deploy flow, and resource management.
---

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    User's Project                       │
│                                                         │
│  effortless.config.ts                                   │
│  src/                                                   │
│    ├── api.ts         → export users = defineApi(...)    │
│    ├── orders.ts      → export orders = ...             │
│    ├── expenses.ts    → export processExpenses = ...    │
│    └── site.ts        → export site = ...               │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    effortless-aws CLI                    │
│                                                         │
│  1. Load config (effortless.config.ts)                  │
│  2. Analyze handlers (ts-morph)                         │
│     - Find all defineApi/defineTable/etc exports         │
│     - Extract metadata from handler configs             │
│  3. Bundle each handler (esbuild)                       │
│     - Tree-shake, minify                                │
│     - Output: dist/<handler-name>/index.js              │
│  4. Deploy to AWS (SDK direct calls)                    │
│     - Create/update IAM roles                           │
│     - Create/update Lambda functions                    │
│     - Create/update triggers (Function URLs, SQS, etc)  │
│     - Wire everything together                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                        AWS                              │
│                                                         │
│  Lambda: my-service-dev-getUsers                        │
│    ← Function URL: https://...lambda-url.../api/users   │
│       Routes: GET /api/users, POST /api/users           │
│                                                         │
│  Lambda: my-service-dev-orders                          │
│    ← DynamoDB Stream: my-service-dev-orders             │
│                                                         │
│  Lambda: my-service-dev-processExpenses                 │
│    ← SQS FIFO: my-service-dev-processExpenses           │
│                                                         │
│  Lambda: my-service-dev-site                            │
│    ← CloudFront: serves static files from S3            │
└─────────────────────────────────────────────────────────┘
```

---

## Code Map

Quick reference for navigating the codebase. All paths are relative to `src/`.

| I want to...                            | Look at                                                                  |
|-----------------------------------------|--------------------------------------------------------------------------|
| Add a new handler type                  | `handlers/define-*.ts`, `build/handler-registry.ts`, `runtime/wrap-*.ts`, `deploy/deploy-*.ts` |
| Change how handlers are bundled         | `build/bundle.ts`, `build/handler-registry.ts`                           |
| Fix deploy behavior                     | `deploy/deploy.ts` (orchestrator), `deploy/shared.ts` (core Lambda)     |
| Understand AWS resource creation        | `aws/lambda.ts`, `aws/iam.ts`, `aws/dynamodb.ts`, `aws/apigateway.ts`  |
| Modify runtime behavior                 | `runtime/handler-utils.ts` (shared logic), `runtime/wrap-*.ts` (per-type) |
| Add a cross-cutting feature             | See [Adding a Feature](#adding-a-cross-cutting-feature) below           |
| Change generated SDK wrappers           | `scripts/gen-aws-sdk.ts` → generates `aws/clients/*.ts`                 |
| Understand handler type system          | `handlers/define-api.ts` (generics `T,C,D,P,S` + conditional intersections) |

### Key directories

| Directory            | Role                                                                      |
|----------------------|---------------------------------------------------------------------------|
| `handlers/`          | **User-facing API** — `defineApi`, `defineTable`, `defineFifoQueue`, `defineApp`, `defineStaticSite`, `param`, `secret` |
| `build/`             | **Build phase** — ts-morph AST parsing (`handler-registry.ts`) + esbuild bundling (`bundle.ts`) |
| `deploy/`            | **Deploy phase** — orchestration (`deploy.ts`), core Lambda (`shared.ts`), per-type deployers |
| `runtime/`           | **Runtime phase** — Lambda wrappers (`wrap-*.ts`), shared utils (`handler-utils.ts`), clients |
| `aws/`               | **AWS operations** — idempotent resource management (`ensureLambda`, `ensureRole`, `ensureTable`, etc.) |
| `aws/clients/`       | **SDK layer** — auto-generated Effect wrappers around AWS SDK v3 (never edit by hand) |
| `cli/commands/`      | **CLI commands** — `deploy`, `build`, `status`, `cleanup`, `layers`      |

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI (eff)                           │
│  deploy, build, status, cleanup, layers                     │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    deploy/ (Orchestration)                  │
│                                                             │
│  deployAll() ─────┬─► deployApiFunction()                  │
│                    ├─► deployTableFunction()                │
│                    ├─► deployFifoQueueFunction()            │
│                    └─► deployAppLambda()                    │
└──────────────────────────────┬──────────────────────────────┘
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
┌────────────────────┐ ┌────────────────┐ ┌────────────────┐
│  build/            │ │  aws/          │ │  runtime/      │
│                    │ │                │ │                │
│  extractConfigs()  │ │  ensureLambda()│ │  wrapApi()     │
│  bundle()          │ │  ensureRole()  │ │  wrapTable()   │
│  zip()             │ │  ensureTable() │ │  wrapQueue()   │
│                    │ │  ensureLayer() │ │  buildDeps()   │
└────────────────────┘ └───────┬────────┘ └────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   aws/clients/ (Generated SDK Layer)        │
│                                                             │
│  Effect-wrapped AWS SDK v3 calls with typed errors          │
│  lambda, iam, dynamodb, apigatewayv2, sqs, s3, ssm, ...    │
└─────────────────────────────────────────────────────────────┘
```

All deploy code uses **Effect.js** — typed errors, composable pipelines, concurrency control via `Effect.gen` + `yield*`.

---

## Build Pipeline

The build system has two phases: **static analysis** (ts-morph) and **bundling** (esbuild). They solve different problems and operate on different parts of the handler definition.

### What the user writes

```typescript
// src/api.ts
export const users = defineApi({
  basePath: "/api",          // ← static config (extracted by ts-morph)
  memory: 512,               // ← static config
})
  .setup(({ deps }) => ({    // ← runtime
    users: deps.users,
  }))
  .get("/users", async ({ req, users }) => ...)        // ← runtime
  .get("/users/{id}", async ({ req, users }) => ...)   // ← runtime
  .post("/users", async ({ input, users }) => ...);    // ← runtime
```

### Phase 1: Static analysis (ts-morph)

`extractHandlerConfigs()` parses the source code as AST and extracts only the serializable config properties (basePath, memory, timeout, permissions). Runtime properties (functions, closures) are stripped via the `RUNTIME_PROPS` list.

```
RUNTIME_PROPS = ["onRecord", "onRecordBatch", "onMessage", "onMessageBatch",
                 "onObjectCreated", "onObjectRemoved", "setup", "schema",
                 "onError", "onCleanup", "deps", "config", "static",
                 "middleware", "auth", "get", "post", "put", "delete", "patch"]
```

This static config is used by the **deploy phase** to configure AWS resources (Lambda Function URLs, Lambda memory/timeout, etc.) without needing to execute user code.

```
Source code  →  ts-morph AST  →  { basePath: "/api", memory: 512 }
                                   (no functions, safe to serialize)
```

### Phase 2: Bundling (esbuild)

`bundle()` creates a **virtual entry point** that imports the user's handler and wraps it with the framework's runtime wrapper. This entry point is never written to disk — it's passed to esbuild via `stdin.contents`.

```
┌─ Virtual entry point (generated in memory) ──────────────────────┐
│                                                                   │
│  import { users } from "/abs/path/to/src/api.ts";                │
│  import { wrapApi } from "/abs/path/to/dist/runtime/wrap-api";   │
│  export const handler = wrapApi(users);                          │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   User's handler code           Framework runtime wrapper
   (defineApi + get/post/        (wrapApi: parses Lambda event,
    schema + setup)               matches routes, validates schema,
                                  calls handler, formats response)
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
  api: {
    wrapperFn: "wrapApi",
    wrapperPath: "~/runtime/wrap-api",  // placeholder prefix
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

defineApi({            ┌─► ts-morph extracts static config ─► deploy phase
  basePath: "/api",    │      { basePath, memory }             (Function URL, Lambda)
  memory: 512,         │
})                     │
  .setup(...)          │
  .get(...)         ───┤
  .post(...)           │
                       └─► esbuild bundles everything ──────► index.mjs
                            (handler + wrapper + deps)         (uploaded to Lambda)
```

---

## Three-Phase Pattern

Every cross-cutting feature (deps, config, static files) follows the same three-phase pattern. Understanding this pattern once lets you understand — or build — any feature.

```
Build (ts-morph AST)        Deploy (Effect)              Runtime (Lambda)
────────────────────        ─────────────────            ──────────────────
extract<Feature>()    →     resolve<Feature>()     →     build<Feature>()
reads config from AST       generates EFF_* env vars     reads env vars,
                            + IAM permissions             initializes clients
                                    │                            │
                                    ▼                            ▼
                            deployCoreLambda()            commonArgs() injects
                            (env + perms merged)          into handler callback
```

### Feature matrix

| Feature | Build function | Extracted data | Deploy function | Env var pattern | Runtime function |
|---------|---------------|----------------|-----------------|-----------------|------------------|
| **deps** | `extractDepsKeys()` | `["orders", "users"]` | `resolveDeps()` | `EFF_TABLE_<key>=<tableName>` | `buildDeps()` → `TableClient` per key |
| **config** | `extractParamEntries()` | `[{propName, ssmKey}]` | `resolveParams()` | `EFF_PARAM_<prop>=/<project>/<stage>/<ssmKey>` | `buildParams()` → batch SSM fetch + transform |
| **static** | `extractStaticGlobs()` | `["src/templates/*.ejs"]` | `resolveStaticFiles()` | _(files bundled in ZIP)_ | `files.read()` → `readFileSync` from cwd |

All `resolve*` results are combined via `mergeResolved()` into a single `{ env, permissions }` payload before being passed to `deployCoreLambda()`.

---

## Adding a New Handler Type

Use `defineFifoQueue` as a template — it's the most recently added handler type and follows all current patterns.

### Step 1: Handler definition (`handlers/define-<type>.ts`)

- Define a branded type: `{ __brand: "effortless-<type>" }`
- Define config type with all static properties (name, memory, timeout, etc.)
- Define callback function types
- Export `define<Type>()` factory function
- Thread generics: `<T, C, D, P, S>` for schema, setup, deps, config, static

### Step 2: Handler registry (`build/handler-registry.ts`)

- Add entry to `handlerRegistry`:
  ```typescript
  <type>: {
    defineFn: "define<Type>",
    wrapperFn: "wrap<Type>",
    wrapperPath: "~/runtime/wrap-<type>",
    handlerProps: { /* type-specific static props */ },
  }
  ```
- Add handler type to `HandlerType` union

### Step 3: Runtime wrapper (`runtime/wrap-<type>.ts`)

- Export `wrap<Type>(handler)` function
- Parse the incoming Lambda event into your handler's format
- Call `createHandlerRuntime()` from `handler-utils.ts` to get shared functionality (setup, deps, config, logging)
- Call the user's callback with `rt.commonArgs()` + type-specific args
- Format and return the Lambda response

### Step 4: Bundle extraction (`build/bundle.ts`)

- Add `extract<Type>Configs()` using `extractHandlerConfigs<Config>(source, "<type>")`
- Call it from `discoverHandlers()`

### Step 5: Deploy function (`deploy/deploy-<type>.ts`)

- Export `deploy<Type>Function()` — calls `deployCoreLambda()` from `shared.ts`
- Export `deploy<Type>()` — creates any AWS resources (queue, table, API route) + calls deploy function
- Handle type-specific wiring (event source mappings, triggers, etc.)

### Step 6: Orchestrator (`deploy/deploy.ts`)

- Add discovery logic in `deployAll()` to find your new handler type
- Wire into the parallel deployment loop
- Handle cleanup for the new resource type

---

## Adding a Cross-Cutting Feature

Use `config` (SSM params) as a template — it's a clean example of the three-phase pattern.

### Step 1: Build — AST extraction (`build/handler-registry.ts`)

Add `extract<Feature>()` that reads the feature's config from the handler AST:
- Use ts-morph to find the property in the handler config object literal
- Extract serializable data (keys, paths, patterns — not functions)
- Add the property name to `RUNTIME_PROPS` so it's stripped from static config
- Store the result in `ExtractedConfig` (add a new field)

### Step 2: Deploy — env vars + IAM (`deploy/deploy.ts` or `deploy/shared.ts`)

Add `resolve<Feature>()` that converts extracted data into Lambda environment:
- Generate `EFF_<FEATURE>_<key>=<value>` environment variables
- Collect IAM permissions the feature needs at runtime
- Return `{ env, permissions }` — `mergeResolved()` will combine with other features

### Step 3: Runtime — lazy init + injection (`runtime/handler-utils.ts`)

Add `build<Feature>()` that reads env vars and initializes at runtime:
- Read `EFF_<FEATURE>_*` env vars
- Create clients / fetch data (lazy init, cached in closure)
- Wire into `commonArgs()` so the feature is injected into handler callbacks

### Step 4: Types — thread the generic

Add a new generic parameter to handler types:
```typescript
& ([F] extends [undefined] ? {} : { featureName: ResolveFeature<F> })
```

This ensures the callback only receives the feature arg when the user configures it.

---

## Resource Discovery & Naming

### Tag-based discovery (no state files)

The CLI finds existing resources via AWS Resource Groups Tagging API. Every deployed resource is tagged:

```
effortless-project = my-service
effortless-stage   = dev
effortless-handler = processExpenses
effortless-component = lambda | sqs | dynamodb | ...
```

This means: no `.tfstate`, no CloudFormation stacks, no lock files. The AWS tags **are** the state.

### Naming convention

All resources include project name and stage, ensuring no collisions:

| Resource | Pattern |
|---|---|
| Lambda function | `${project}-${stage}-${handler}` |
| IAM role | `${project}-${stage}-${handler}-role` |
| Function URL | _(auto-created per Lambda, no separate name)_ |
| DynamoDB table | `${project}-${stage}-${handler}` |
| SQS FIFO queue | `${project}-${stage}-${handler}` |
| Lambda layer | `${project}-${stage}-deps` |

### Stage isolation

Each stage (`dev`, `staging`, `prod`) is a **fully independent set of resources**. No shared infrastructure between stages — separate Lambda functions, separate Function URLs, separate tables. Destroying `dev` never risks touching `prod`.

### Deploy algorithm

```
deploy:
  1. discover handlers from code (AST analysis)
  2. prepare shared dependency layer (hash-based, skip if unchanged)
  3. create/update resources for each handler (5 concurrent)
  4. tag all resources

cleanup:
  1. query AWS by tags → find all resources for project+stage
  2. group by handler
  3. delete selected resources (--all or --handler <name>)
```

---

## Environment Variables Reference

Environment variables injected into Lambda functions at deploy time:

| Variable | Set by | Purpose |
|----------|--------|---------|
| `EFF_PROJECT` | always | Project name from config |
| `EFF_STAGE` | always | Stage name (default: `dev`) |
| `EFF_HANDLER` | always | Handler export name |
| `EFF_TABLE_<key>` | `resolveDeps()` | DynamoDB table name for each dependency |
| `EFF_TABLE_SELF` | `deploy-table.ts` | Own table name (table stream handlers only) |
| `EFF_PARAM_<prop>` | `resolveParams()` | SSM path: `/${project}/${stage}/${ssmKey}` |
| `EFF_QUEUE_URL` | `deploy-fifo-queue.ts` | SQS queue URL (queue handlers only) |
| `EFF_QUEUE_ARN` | `deploy-fifo-queue.ts` | SQS queue ARN (queue handlers only) |

---

## Design Decisions

### No state files

Resources are discovered via AWS tags instead of local state (CloudFormation, Terraform `.tfstate`). This eliminates state file drift, lock conflicts, and the need for remote state backends. The trade-off: tag queries are slower than reading a local file, and tags have a 50-tag-per-resource limit.

### ts-morph for static analysis

ts-morph (TypeScript compiler wrapper) is used instead of Babel or regex parsing. It understands TypeScript natively — generic parameters, branded types, and const assertions all work correctly. The downside is it's heavier than Babel, but since it only runs at build time this is acceptable.

### Effect.js for deploy orchestration

All deploy code uses [Effect](https://effect.website/) for composable, typed error handling. This gives us: typed errors per AWS operation (`LambdaError`, `IAMError`), automatic retry logic, structured concurrency (parallel deploys with a limit of 5), and clean `gen`/`yield*` syntax. The learning curve is steep, but deploy code is write-once and rarely changes.

### Separate stages, no shared resources

Each stage gets its own Lambda functions, Function URLs, tables, etc. Sharing resources means shared rate limits and blast radius. Full isolation is simpler and safer.

### No secrets in environment variables

For SSM parameters, only the **path** (e.g. `/${project}/${stage}/db-url`) is stored as a Lambda env var. Actual secret values are fetched at runtime via `GetParameters` with `WithDecryption: true`. This means secrets never appear in Lambda console, CloudFormation outputs, or deployment logs.

### Deterministic builds

ZIP files use `FIXED_DATE = new Date(0)` for all entries. Same source code produces the same ZIP hash, so `ensureLambda()` can skip re-upload when only timestamps changed. This makes deploys fast when only one handler changes.

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

### Layer Reuse

Layers are versioned by a SHA-256 hash of all `package@version` pairs. If the hash matches an existing published layer version, it's reused — no re-upload needed. This makes deploys fast when only handler code changes.

### Dependency Warnings

The CLI warns about common `package.json` mistakes that affect the layer:

- **Dev packages in `dependencies`** — packages like `typescript`, `@types/*`, `eslint`, `vitest`, `tsup` in `dependencies` will be included in the layer, bloating its size unnecessarily. Move them to `devDependencies`.
- **Empty `dependencies`** — if `dependencies` is empty but `devDependencies` has packages, the layer will be empty. Runtime packages must be in `dependencies` to be included.

These warnings appear during `eff deploy` and `eff layer`.

### Monorepo Note

When using the `root` config option, the layer reads `package.json` and `node_modules` from the **directory where you run the CLI** (`cwd`), not from the resolved `root`. This ensures the correct project-level dependencies are used, not workspace-root dependencies.

### AWS SDK Handling

AWS SDK v3 packages (`@aws-sdk/*`, `@smithy/*`) are **always excluded** from both the layer and the handler bundle. They're provided by the Lambda Node.js runtime, which keeps the layer size small and avoids version conflicts.

---

## Prior Art

- [Firebase Functions](https://firebase.google.com/docs/functions) — inspiration for DX
- [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) — inspiration for runtime best practices (batch processing, idempotency, structured logging, metrics, tracing)
- [SST](https://sst.dev/) — infrastructure from code for AWS
- [Nitric](https://nitric.io/) — cloud-agnostic declarative framework
- [Pulumi](https://www.pulumi.com/) — infrastructure as code
