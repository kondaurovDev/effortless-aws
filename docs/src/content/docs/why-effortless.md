---
title: Why Effortless?
description: The problems with current Lambda tooling and how Effortless solves them.
---

You want to build a backend on AWS Lambda. You write a handler function. Then the real work begins.

## The problem

Adding a single Lambda endpoint today looks like this:

1. Write the handler code
2. Define the Lambda in a separate infrastructure file (CDK construct, SST config, Terraform resource)
3. Wire up API Gateway route to the Lambda
4. Link the table to the function or grant permissions
5. Pass the table name via environment variables
6. Wait 1-5 minutes for CloudFormation/Pulumi to deploy

**Six steps for one endpoint.** Tools like CDK and SST automate parts of this (IAM roles, for example), but you still write infrastructure definitions in separate files, keep them in sync with your handler code, and wait for CloudFormation or Pulumi to reconcile state.

### What a typical project looks like

```
my-service/
├── src/
│   └── handlers/
│       └── createOrder.ts        ← your code (the part you care about)
├── infra/
│   ├── ApiStack.ts               ← API Gateway + routes
│   ├── DatabaseStack.ts          ← DynamoDB tables + grants
│   └── FunctionStack.ts          ← Lambda definitions + linking
├── sst.config.ts                 ← or cdk.json, serverless.yml, main.tf...
└── package.json
```

Your handler is one file. The infrastructure around it is three or four. Every time you add an endpoint, rename a table, or change a dependency — you update both your code and the infra files.

## The Effortless approach

Same project:

```
my-service/
├── src/
│   └── orders.ts                 ← handler + infrastructure in one place
├── effortless.config.ts          ← project name, region, defaults
└── package.json
```

```bash
npx eff deploy    # ~10 seconds
```

This single file creates:
- DynamoDB table with partition key
- Stream processor Lambda (triggered on inserts/updates)
- HTTP Lambda with DynamoDB write permissions
- API Gateway `POST /orders` route
- IAM roles for both Lambdas
- Environment variables for table name wiring

**No YAML. No state files. No IAM policy writing.**

<details>
<summary>See the code — src/orders.ts</summary>

```typescript
import { defineTable, defineHttp, typed } from "effortless-aws";

type Order = { id: string; product: string; amount: number };

export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    console.log("New order:", record.new!.product);
  },
});

export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ req, deps }) => {
    await deps.orders.put({
      id: crypto.randomUUID(),
      product: req.body.product,
      amount: req.body.amount,
    });
    return { status: 201, body: { ok: true } };
  },
});
```

</details>

## What Effortless is not

- **Not multi-cloud.** AWS only. This focus is what makes deep integration possible.
- **Not a managed platform.** Deploys to your AWS account. You own the resources.
- **Not a full IaC tool.** Focused on the Lambda ecosystem (Lambda, API Gateway, DynamoDB, SQS, EventBridge, S3, CloudFront). For VPCs, RDS, or ECS — use Terraform/CDK alongside.
- **Not zero-config.** You still need `effortless.config.ts` for project name and region. But that's one file, not five.

## Use cases

### REST API with database

The most common Lambda pattern: HTTP endpoints that read/write from DynamoDB.

- **Schema validation** — invalid requests rejected before your handler runs
- **Typed clients** — `deps.users.put()` knows the shape of `User`
- **Auto IAM** — each Lambda gets exactly the DynamoDB permissions it needs
- **Table name wiring** — no hardcoded ARNs or environment variable plumbing

<details>
<summary>See the code</summary>

```typescript
import { defineTable, defineHttp, typed } from "effortless-aws";
import { Schema } from "effect";

type User = { id: string; email: string; name: string; createdAt: string };

export const users = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<User>(),
});

// POST /users — validated request body
export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  schema: Schema.Struct({
    email: Schema.String,
    name: Schema.String,
  }),
  deps: { users },
  onRequest: async ({ data, deps }) => {
    const user: User = {
      id: crypto.randomUUID(),
      email: data.email,    // typed from schema
      name: data.name,
      createdAt: new Date().toISOString(),
    };
    await deps.users.put(user);  // typed client, auto IAM
    return { status: 201, body: user };
  },
});

// GET /users/{id}
export const getUser = defineHttp({
  method: "GET",
  path: "/users/{id}",
  deps: { users },
  onRequest: async ({ req, deps }) => {
    const user = await deps.users.get({ id: req.params.id });
    if (!user) return { status: 404, body: { error: "Not found" } };
    return { status: 200, body: user };
  },
});
```

</details>

### Event-driven processing

DynamoDB streams let you react to data changes without polling. The stream, event source mapping, batch size config, and partial failure reporting are all handled automatically.

<details>
<summary>See the code</summary>

```typescript
import { defineTable, typed } from "effortless-aws";

type Order = { id: string; product: string; amount: number; status: string };

export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  // Stream processor — runs on every insert/update/delete
  onRecord: async ({ record }) => {
    if (record.eventName === "INSERT") {
      // Send confirmation email, update analytics, notify warehouse
      console.log(`New order: ${record.new!.product} — $${record.new!.amount}`);
    }
  },
});

// Or process records in batches for efficiency
export const analytics = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<AnalyticsEvent>(),
  batchSize: 100,
  onBatch: async ({ records }) => {
    const inserts = records.filter(r => r.eventName === "INSERT");
    await bulkIndexToElasticsearch(inserts.map(r => r.new!));
  },
});
```

</details>

### Static site / SPA behind API Gateway

Serve a React/Vue/Astro app alongside your API — same project, same deploy. Or use CloudFront + S3 for global CDN distribution.

<details>
<summary>See the code</summary>

```typescript
import { defineApp, defineHttp } from "effortless-aws";

// Static site served via Lambda
export const app = defineApp({
  path: "/",
  dir: "dist",
  build: "npm run build",
  spa: true,  // all routes → index.html
});

// API endpoints alongside the site
export const getItems = defineHttp({
  method: "GET",
  path: "/api/items",
  onRequest: async () => {
    return { status: 200, body: await fetchItems() };
  },
});
```

Or use CloudFront + S3 for global CDN distribution:

```typescript
import { defineCdn } from "effortless-aws";

export const site = defineCdn({
  dir: "dist",
  build: "npm run build",
  spa: true,
});
```

</details>

### Secrets and configuration

Pull secrets from SSM Parameter Store at cold start — cached, typed, auto-permissioned. No manual SSM calls, no `GetParameter` permission writing, no environment variable plumbing.

<details>
<summary>See the code</summary>

```typescript
import { defineHttp, param } from "effortless-aws";

export const checkout = defineHttp({
  method: "POST",
  path: "/checkout",
  params: {
    stripeKey: param("stripe/secret-key"),
    webhookSecret: param("stripe/webhook-secret"),
  },
  onRequest: async ({ params }) => {
    // params.stripeKey is fetched from SSM once, cached across invocations
    const stripe = new Stripe(params.stripeKey);
    // ...
  },
});
```

</details>

## What you don't need to learn

| Concept | Traditional | Effortless |
|---------|-------------|------------|
| IAM policies | `.grant*()` calls or `link` in infra files | Automatic from `deps` and `params` |
| CloudFormation / CDK | Learn constructs, stacks, synthesis | Not used |
| Terraform / HCL | Learn HCL, manage state, plan/apply | Not used |
| State management | S3 backends, locking, drift detection | AWS tags — no state files |
| Infra ↔ code sync | Keep infra files in sync with handler code | One file — handler is the infra |
| API Gateway config | Routes, integrations, stages, deployments | Derived from `method` + `path` |
| DynamoDB streams | Event source mappings, batch config, failure handling | Add `onRecord` to your table |
| Lambda Layers | Build, publish, version, attach to functions | Automatic for `node_modules` |

## Next steps

- [Installation](/installation/) — install and deploy your first handler in 2 minutes
- [Handlers](/handlers/) — all handler types and their options
- [Architecture](/architecture/) — how static analysis, bundling, and deployment work
- [Comparisons](/comparisons/) — detailed comparisons with SST, Nitric, Serverless Framework, and others
