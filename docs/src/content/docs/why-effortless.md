---
title: Why Effortless?
description: The problems with current Lambda tooling and how Effortless solves them.
---

You want to build a backend on AWS Lambda. You write a handler function. Then the real work begins.

## The problem

Adding a single Lambda endpoint today looks like this:

1. Write the handler code
2. Define the Lambda in CloudFormation/CDK/Terraform/SST config
3. Create an IAM role with the right permissions
4. Wire up API Gateway route
5. Configure environment variables for table names
6. Update the deployment pipeline
7. Wait 2-5 minutes for CloudFormation to deploy

**Seven steps for one endpoint.** And if you need a DynamoDB table with a stream processor, multiply that by three.

The code is the easy part. Everything around it — the YAML, the state files, the IAM policies, the config wiring — that's where the time goes.

### What a typical project looks like

```
my-service/
├── src/
│   └── handlers/
│       └── createOrder.ts        ← your code (the part you care about)
├── infra/
│   ├── stacks/
│   │   ├── ApiStack.ts           ← API Gateway config
│   │   ├── DatabaseStack.ts      ← DynamoDB config
│   │   └── FunctionStack.ts      ← Lambda config
│   └── permissions.ts            ← IAM policies
├── sst.config.ts                 ← or cdk.json, serverless.yml, main.tf...
└── package.json
```

Your handler is one file. The infrastructure around it is five. And they all need to stay in sync manually.

## The Effortless approach

Same project:

```
my-service/
├── src/
│   └── orders.ts                 ← handler + infrastructure in one place
├── effortless.config.ts          ← project name, region, defaults
└── package.json
```

```typescript
// src/orders.ts
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

```bash
eff deploy    # ~10 seconds
```

This single file creates:
- DynamoDB table with partition key
- Stream processor Lambda (triggered on inserts/updates)
- HTTP Lambda with DynamoDB write permissions
- API Gateway `POST /orders` route
- IAM roles for both Lambdas
- Environment variables for table name wiring

**No YAML. No state files. No IAM policy writing.**

## Use cases

### REST API with database

The most common Lambda pattern: HTTP endpoints that read/write from DynamoDB.

```typescript
import { defineTable, defineHttp, typed } from "effortless-aws";
import { z } from "zod";

type User = { id: string; email: string; name: string; createdAt: string };

export const users = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<User>(),
});

// POST /users — validated request body
export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  schema: (input: unknown) =>
    z.object({ email: z.string(), name: z.string() }).parse(input),
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

What you get without writing any infrastructure:
- **Schema validation** — invalid requests rejected before your handler runs
- **Typed clients** — `deps.users.put()` knows the shape of `User`
- **Auto IAM** — each Lambda gets exactly the DynamoDB permissions it needs
- **Table name wiring** — no hardcoded ARNs or environment variable plumbing

### Event-driven processing

DynamoDB streams let you react to data changes without polling.

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

The stream, event source mapping, batch size config, and partial failure reporting are all handled automatically.

### SSR framework deployment

Deploy Nuxt, Astro SSR, or any framework with server-side rendering — CloudFront CDN with Lambda Function URL for SSR and S3 for static assets.

```typescript
import { defineApp, defineHttp } from "effortless-aws";

// SSR app via CloudFront + Lambda Function URL
export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  domain: "app.example.com",
});

// API endpoints in the same project
export const getItems = defineHttp({
  method: "GET",
  path: "/api/items",
  onRequest: async () => {
    return { status: 200, body: await fetchItems() };
  },
});
```

Or for static sites, use CloudFront + S3:

```typescript
import { defineStaticSite } from "effortless-aws";

export const site = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  spa: true,
});
```

### Secrets and configuration

Pull secrets from SSM Parameter Store at cold start — cached, typed, auto-permissioned.

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

No manual SSM calls. No `GetParameter` permission writing. No environment variable plumbing.

## What you don't need to learn

| Concept | Traditional | Effortless |
|---------|-------------|------------|
| IAM policies | Write JSON policies, attach to roles | Automatic from `deps` and `params` |
| CloudFormation / CDK | Learn constructs, stacks, synthesis | Not used |
| Terraform / HCL | Learn HCL, manage state, plan/apply | Not used |
| State management | S3 backends, locking, drift detection | AWS tags — no state files |
| API Gateway config | Routes, integrations, stages, deployments | Derived from `method` + `path` |
| DynamoDB streams | Event source mappings, batch config, failure handling | Add `onRecord` to your table |
| Lambda Layers | Build, publish, version, attach to functions | Automatic for `node_modules` |

## What Effortless is not

- **Not multi-cloud.** AWS only. This focus is what makes deep integration possible.
- **Not a managed platform.** Deploys to your AWS account. You own the resources.
- **Not a full IaC tool.** Focused on the Lambda ecosystem (Lambda, API Gateway, DynamoDB, SQS, EventBridge, S3, CloudFront). For VPCs, RDS, or ECS — use Terraform/CDK alongside.
- **Not zero-config.** You still need `effortless.config.ts` for project name and region. But that's one file, not five.

## Next steps

- [Installation](/installation/) — install and deploy your first handler in 2 minutes
- [Definitions](/definitions/) — all definition types and their options
- [Architecture](/architecture/) — how static analysis, bundling, and deployment work
- [Comparisons](/comparisons/) — detailed comparisons with SST, Nitric, Serverless Framework, and others
