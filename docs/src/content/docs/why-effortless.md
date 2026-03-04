---
title: Why Effortless?
description: Ship entire products on AWS serverless — API, database, website, queues, email — from TypeScript alone.
---

Serverless is the right model for shipping products. Pay per use, scale to zero, zero ops — Lambda, DynamoDB, SQS, S3, SES, CloudFront are proven, scalable services that handle everything from a side project to production traffic.

But delivering a serverless product is unreasonably hard.

## The problem

Serverless services are simple individually. The hard part is wiring them into a product. Every product needs an API, a database, maybe a queue, file storage, email, and a frontend. Each is a separate AWS service — and connecting them means:

- **CloudFormation / CDK / Terraform stacks** — even a simple app requires hundreds of lines of infrastructure config
- **IAM policies for every connection** — your API Lambda needs DynamoDB access, your stream Lambda needs SQS access, your queue Lambda needs S3 access — each permission written manually
- **Event source mappings** — wiring DynamoDB Streams to Lambda, SQS to Lambda, S3 events to Lambda — each with its own config
- **Environment variables** — table names, queue URLs, bucket names passed between services
- **Deployment orchestration** — minutes-long CloudFormation deploys, state files to manage, drift to detect

The code for each handler is 10–20 lines. The infrastructure around it is 10x that. You spend more time wiring services together than building the product itself.

## With Effortless — ship the whole product

Same product, same AWS services — but you only write the parts that matter:

```
my-service/
├── src/
│   ├── orders.ts                 ← API + database + stream processing
│   ├── uploads.ts                ← file storage + image processing
│   └── notifications.ts         ← queue + email
├── effortless.config.ts          ← project name, region, defaults
└── package.json
```

Each handler definition creates all the AWS resources it needs. `deps` wires them together — IAM permissions, environment variables, typed clients — automatically.

```typescript
// src/orders.ts
import { defineTable, defineApi, typed } from "effortless-aws";

type Order = { id: string; product: string; amount: number };

export const orders = defineTable({
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    console.log("New order:", record.new!.product);
  },
});

export const api = defineApi({
  basePath: "/orders",
  deps: { orders },
  post: async ({ req, deps }) => {
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
eff deploy    # ~10 seconds — the whole product
```

One command creates everything: DynamoDB table, stream processor Lambda, API Lambda with Function URL, IAM roles, environment variable wiring. **No YAML. No state files. No IAM policy writing.**

### Everything a product needs

| Your product needs | Effortless handler | AWS resources created |
|---|---|---|
| REST API | `defineApi` | Lambda + Function URL + IAM |
| Database | `defineTable` | DynamoDB + optional stream Lambda |
| Background jobs | `defineFifoQueue` | SQS FIFO + consumer Lambda |
| File storage | `defineBucket` | S3 + optional event Lambda |
| Transactional email | `defineMailer` | SES + DKIM identity |
| Website / SSR app | `defineApp` | CloudFront + Lambda + S3 |
| Static site / SPA | `defineStaticSite` | CloudFront + S3 |

All in the same project, all deployed with one command, all with automatic IAM wiring between them.

```typescript
// One project. One deploy. A complete product backend.
export const orders   = defineTable({ schema: typed<Order>(), onRecord: processOrder });
export const uploads  = defineBucket({ onObjectCreated: processImage });
export const queue    = defineFifoQueue({ schema: typed<Job>(), onMessage: processJob });
export const mailer   = defineMailer({ domain: "myapp.com" });
export const api      = defineApi({
  basePath: "/api",
  deps: { orders, uploads, queue, mailer },
  // all deps are typed, all IAM permissions are automatic
});
export const site     = defineStaticSite({ dir: "dist", build: "npm run build" });
```

You can deliver an entire serverless product from TypeScript alone — and get back to building the product itself.

## Use cases

### REST API with database

The most common Lambda pattern: HTTP endpoints that read/write from DynamoDB.

```typescript
import { defineTable, defineApi, typed } from "effortless-aws";
import { z } from "zod";

type User = { id: string; email: string; name: string; createdAt: string };

export const users = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<User>(),
});

export const api = defineApi({
  basePath: "/users",
  deps: { users },

  get: {
    "/{id}": async ({ req, deps }) => {
      const user = await deps.users.get({ id: req.params.id });
      if (!user) return { status: 404, body: { error: "Not found" } };
      return { status: 200, body: user };
    },
  },

  schema: (input: unknown) =>
    z.object({ email: z.string(), name: z.string() }).parse(input),
  post: async ({ data, deps }) => {
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
type AnalyticsEvent = { id: string; event: string; timestamp: number };

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
import { defineApp, defineApi } from "effortless-aws";

// SSR app via CloudFront + Lambda Function URL
export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  domain: "app.example.com",
});

// API endpoints in the same project
export const api = defineApi({
  basePath: "/api",
  get: {
    "/items": async () => {
      return { status: 200, body: await fetchItems() };
    },
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
import { defineApi, param } from "effortless-aws";

export const checkout = defineApi({
  basePath: "/checkout",
  config: {
    stripeKey: param("stripe/secret-key"),
    webhookSecret: param("stripe/webhook-secret"),
  },
  post: async ({ config }) => {
    // config.stripeKey is fetched from SSM once, cached across invocations
    const stripe = new Stripe(config.stripeKey);
    // ...
  },
});
```

No manual SSM calls. No `GetParameter` permission writing. No environment variable plumbing.

## What you don't need to learn

| Concept | Traditional | Effortless |
|---------|-------------|------------|
| IAM policies | Write JSON policies, attach to roles | Automatic from `deps` and `config` |
| CloudFormation / CDK | Learn constructs, stacks, synthesis | Not used |
| Terraform / HCL | Learn HCL, manage state, plan/apply | Not used |
| State management | S3 backends, locking, drift detection | AWS tags — no state files |
| API Gateway config | Routes, integrations, stages, deployments | Derived from `basePath` + route definitions |
| DynamoDB streams | Event source mappings, batch config, failure handling | Add `onRecord` to your table |
| Lambda Layers | Build, publish, version, attach to functions | Automatic for `node_modules` |

## What Effortless is not

- **Not multi-cloud.** AWS only. This focus is what makes deep integration possible.
- **Not a managed platform.** Deploys to your AWS account. You own the resources.
- **Not a full IaC tool.** Covers the serverless product stack (Lambda, DynamoDB, SQS, S3, SES, CloudFront). For VPCs, RDS, or ECS — use Terraform/CDK alongside.
- **Not zero-config.** You still need `effortless.config.ts` for project name and region. But that's one file, not five.

## Next steps

- [Installation](/installation/) — install and deploy your first handler in 2 minutes
- [Definitions](/definitions/) — all definition types and their options
- [Architecture](/architecture/) — how static analysis, bundling, and deployment work
- [Comparisons](/comparisons/) — detailed comparisons with SST, Nitric, Serverless Framework, and others
