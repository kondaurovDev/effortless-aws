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
│                  @effect-ak/effortless CLI                  │
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
@effect-ak/effortless/
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
│   │   ├── permissions.ts      #   IAM permission types
│   │   └── index.ts
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

---

## Prior Art

- [Firebase Functions](https://firebase.google.com/docs/functions) - inspiration for DX
- [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) - inspiration for runtime best practices (batch processing, idempotency, structured logging, metrics, tracing)
- [SST](https://sst.dev/) - infrastructure from code for AWS
- [Nitric](https://nitric.io/) - cloud-agnostic declarative framework
- [Pulumi](https://www.pulumi.com/) - infrastructure as code
