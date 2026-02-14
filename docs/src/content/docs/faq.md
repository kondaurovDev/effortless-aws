---
title: FAQ
description: Common questions about Effortless AWS — deployment, pricing, cold starts, DynamoDB, IAM, and more.
---

## General

### What is Effortless AWS?

A TypeScript framework for AWS Lambda. You export handler functions — Effortless creates Lambda functions, DynamoDB tables, API Gateway routes, IAM roles, and everything else automatically. No YAML, no CloudFormation, no state files.

```typescript
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
});
```

This single export creates: a DynamoDB table, a typed client for `.put()` / `.get()`, and IAM permissions when used as a dependency. See [Why Effortless?](/why-effortless/) for the full story.

### Do I need to learn CloudFormation or CDK?

No. Effortless doesn't use CloudFormation at all. It makes direct AWS SDK calls to create and update resources. This means deploys take 5-10 seconds instead of minutes, and there are no stack limits, no drift, no rollback delays.

See [Why Not CloudFormation?](/comparisons/#why-not-cloudformation) for a detailed comparison.

### How is this different from SST?

SST is infrastructure **as** code — you write infrastructure definitions in `sst.config.ts`, then link them to your handler code. Effortless is infrastructure **from** code — you export a handler, and the infrastructure is created automatically.

Key differences: Effortless gives you typed clients from `defineTable`, deploys in 5-10s (vs ~30s for SST), and uses no state files. SST has a mature Console UI and broader community. See [full comparison](/comparisons/#why-not-sst).

### Is Effortless production-ready?

Effortless deploys standard AWS resources — Lambda, DynamoDB, API Gateway, SQS, CloudFront. These are the same services used by Netflix, Airbnb, and thousands of production workloads. The framework itself is early-stage, but the underlying infrastructure is battle-tested.

### Does Effortless support multi-cloud?

No. AWS only. This is intentional — by focusing on one cloud, Effortless provides deep integration with AWS-native features like DynamoDB Streams, SQS FIFO ordering, and CloudFront edge caching. Multi-cloud frameworks sacrifice these capabilities for portability. See [Why AWS?](/why-aws/).

---

## Deployment

### How long does a deploy take?

Typically 5-10 seconds for a full deploy, 3-5 seconds for a code-only update. Effortless makes direct AWS SDK calls in parallel instead of going through CloudFormation.

| Operation | CloudFormation | Effortless |
|-----------|----------------|------------|
| Create Lambda | 60-120s | 5-10s |
| Update Lambda code | 30-60s | 3-5s |
| Full redeploy | 5-10 min | 30-60s |

### How do I deploy to different environments?

Use the `--stage` flag. Each stage gets fully isolated resources — separate tables, Lambdas, API Gateway.

```bash
npx eff deploy              # default stage (dev)
npx eff deploy --stage prod # production
```

No shared state between stages. Each stage is completely independent.

### Does Effortless use state files?

No. Effortless uses AWS resource tags as the source of truth. Every resource is tagged with the project name, stage, and handler name. To discover existing resources, it queries the Resource Groups Tagging API.

This means: no S3 backends, no lock files, no state drift, no "terraform import". If the resource exists in AWS with the right tags, Effortless finds it.

### Can I use Effortless in CI/CD?

Yes. `npx eff deploy` works in any environment with AWS credentials. For GitHub Actions:

```yaml
- name: Deploy
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    AWS_REGION: eu-west-1
  run: npx eff deploy --stage prod
```

### What happens if I stop using Effortless?

Your resources continue to work. Effortless creates standard AWS Lambda functions, DynamoDB tables, and API Gateway APIs. They don't depend on Effortless at runtime. You can manage them with the AWS Console, CDK, or Terraform going forward.

---

## AWS and Pricing

### How much does it cost?

For most projects: **$0-5/month**. You pay only for AWS usage, not for Effortless.

AWS Free Tier (permanent, not trial):
- **Lambda**: 1M requests/month free
- **DynamoDB**: 25 GB storage + 25 read/write capacity units free
- **API Gateway**: 1M requests/month free (first 12 months)
- **SQS**: 1M requests/month free
- **CloudFront**: 1 TB transfer/month free (first 12 months)

See [Why AWS? — Cost](/why-aws/#cost-almost-free) for details.

### What AWS credentials do I need?

An IAM user or role with permissions to create Lambda functions, DynamoDB tables, API Gateway APIs, IAM roles, and SQS queues. See [Installation — AWS Credentials](/installation/#aws-credentials) for setup options including `~/.aws/credentials`, environment variables, and SSO.

### What AWS region should I use?

The region closest to your users. Effortless supports any AWS region. Set it in `effortless.config.ts`:

```typescript
export default defineConfig({
  name: "my-app",
  region: "eu-west-1", // Ireland
});
```

---

## Lambda and Performance

### What about Lambda cold starts?

Node.js Lambda cold starts are typically 100-200ms. Warm invocations respond in single-digit milliseconds. Effortless bundles only the code each handler needs (via esbuild tree-shaking), which keeps cold starts minimal.

Heavy dependencies go into a shared Lambda Layer. This is handled automatically — you don't configure anything.

### Can I control Lambda memory and timeout?

Yes, in `effortless.config.ts`:

```typescript
export default defineConfig({
  name: "my-app",
  region: "eu-west-1",
  defaults: {
    memorySize: 512,  // MB
    timeout: 30,      // seconds
  },
});
```

You can also override per handler. See [Configuration](/configuration/).

### Can I use Lambda inside a VPC?

Yes. Configure VPC settings in `effortless.config.ts`:

```typescript
export default defineConfig({
  name: "my-app",
  region: "eu-west-1",
  vpc: {
    subnetIds: ["subnet-abc", "subnet-def"],
    securityGroupIds: ["sg-123"],
  },
});
```

### Can I use npm packages in my handlers?

Yes. Effortless automatically bundles your code and `node_modules` with esbuild. Large dependencies are moved to a shared Lambda Layer (managed automatically with hash-based versioning). You don't configure any of this.

---

## DynamoDB

### How do I create a DynamoDB table?

Export a `defineTable` call. That's it.

```typescript
import { defineTable, typed } from "effortless-aws";

type User = { id: string; email: string; name: string };

export const users = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<User>(),
});
```

This creates the table, a typed client (`.put()`, `.get()`, `.delete()`), and wires IAM permissions when used as `deps`. See [Database guide](/use-cases/database/).

### Can I use a sort key?

Yes:

```typescript
export const messages = defineTable({
  pk: { name: "channelId", type: "string" },
  sk: { name: "timestamp", type: "number" },
  schema: typed<Message>(),
});
```

### How do I react to data changes?

Add `onRecord` to process each change, or `onBatch` for batch processing:

```typescript
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    if (record.eventName === "INSERT") {
      console.log("New order:", record.new!.id);
    }
  },
});
```

This creates a DynamoDB Stream and a Lambda that processes changes in real time. See [Database — Reacting to data changes](/use-cases/database/#reacting-to-data-changes).

### Can I use a table from another handler?

Yes, via `deps`. This automatically wires IAM permissions:

```typescript
import { orders } from "./db";

export const listOrders = defineHttp({
  method: "GET",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ deps }) => {
    // deps.orders has typed .get(), .put(), .delete()
  },
});
```

---

## HTTP API

### How do I validate request bodies?

Use the `schema` option with Effect Schema:

```typescript
import { Schema } from "effect";

export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  schema: Schema.Struct({
    email: Schema.String,
    name: Schema.String,
  }),
  onRequest: async ({ data }) => {
    // data.email and data.name are typed and validated
  },
});
```

Invalid requests get a 400 response before your handler runs. See [HTTP API — Validating input](/use-cases/http-api/#validating-input).

### How do I read path parameters?

They come from `req.params`:

```typescript
export const getUser = defineHttp({
  method: "GET",
  path: "/users/{id}",
  onRequest: async ({ req }) => {
    const userId = req.params.id;
  },
});
```

### Can I use secrets (API keys, tokens)?

Yes, via `param()` which reads from SSM Parameter Store:

```typescript
import { param } from "effortless-aws";

export const checkout = defineHttp({
  method: "POST",
  path: "/checkout",
  params: { stripeKey: param("stripe/secret-key") },
  onRequest: async ({ params }) => {
    // params.stripeKey fetched once at cold start, cached after
  },
});
```

Store the secret in SSM first: `aws ssm put-parameter --name /my-app/dev/stripe/secret-key --value sk_... --type SecureString`. See [HTTP API — Using secrets](/use-cases/http-api/#using-secrets).

---

## Static Sites

### Can I host a React/Vue/Astro site?

Yes, two options:

**Same domain as API** (via Lambda + API Gateway):
```typescript
export const app = defineApp({
  path: "/",
  dir: "dist",
  build: "npm run build",
  spa: true,
});
```

**Global CDN** (via CloudFront + S3):
```typescript
export const site = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  spa: true,
});
```

See [Website guide](/use-cases/web-app/) for the full comparison.

### Which hosting option should I choose?

| | `defineApp` | `defineStaticSite` |
|---|---|---|
| Served from | Lambda + API Gateway | CloudFront CDN (edge) |
| Latency | Regional (single region) | Global (~50ms worldwide) |
| Same domain as API | Yes | Separate domain |
| Cost | Lambda invocations | CloudFront transfer |
| Best for | Internal tools, prototypes | Public-facing sites |

---

## Queues

### When should I use a queue vs DynamoDB streams?

Use **DynamoDB streams** (`onRecord`) when reacting to data changes — a new order triggers an email, a user update syncs to analytics.

Use **SQS FIFO queues** (`defineFifoQueue`) for task processing — sending emails, processing payments, generating reports. Queues give you retry logic, dead-letter queues, and backpressure handling.

See [Queue — When to use queues vs streams](/use-cases/queue/#when-to-use-queues-vs-streams).

---

## Troubleshooting

### My deploy says "credentials not found"

Effortless needs AWS credentials. Options:
1. `~/.aws/credentials` file (most common)
2. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables
3. AWS SSO via `aws sso login`

See [Installation — AWS Credentials](/installation/#aws-credentials).

### My Lambda returns 502 Bad Gateway

Common causes:
- **Handler threw an error** — check CloudWatch Logs: `npx eff logs <handler-name>`
- **Timeout** — default is 30s, increase in config if needed
- **Missing permissions** — if your handler calls AWS services not managed by Effortless, add them to `permissions` in handler config

### My DynamoDB table already exists

Effortless uses tags to discover resources. If you created a table manually with the same name, either:
1. Delete it and let Effortless create it
2. Add the correct tags: `effortless:project`, `effortless:stage`, `effortless:handler`

### Deploy is slow (>30s)

Usually means a large `node_modules` is being uploaded. Effortless uses Lambda Layers with hash-based caching — the first deploy with new dependencies is slower, subsequent deploys reuse the layer.
