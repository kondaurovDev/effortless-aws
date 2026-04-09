# effortless-aws

[![npm version](https://img.shields.io/npm/v/effortless-aws)](https://www.npmjs.com/package/effortless-aws)
[![npm downloads](https://img.shields.io/npm/dw/effortless-aws)](https://www.npmjs.com/package/effortless-aws)

You write handlers. The framework builds, bundles, provisions AWS resources, wires IAM permissions, and deploys — all from your TypeScript code.

Your TypeScript is the single source of truth — for code and infrastructure.

## You write this

```typescript
import { defineApi, defineTable } from "effortless-aws";

const db = defineTable<Order>();

export const api = defineApi({ basePath: "/orders" })
  .deps(() => ({ db }))
  .get("/{id}", async ({ params, deps, ok }) => {
    const order = await deps.db.get(params.id);
    return ok(order);
  });
```

## You run this

```bash
eff deploy
```

## The framework handles the rest

From the example above, `eff deploy` will:

- **Bundle** your code with esbuild and package dependencies into a Lambda layer
- **Create a DynamoDB table** with streams and indexes — from `defineTable<Order>()`
- **Create a Lambda** with a public HTTP endpoint — from `defineApi()`
- **Wire IAM permissions** so the API can read/write the table — from `.deps(() => ({ db }))`
- **Type everything** — `deps.db.get()` returns `Order`, no casts, no `as any`

The same principle works for S3 buckets, SQS queues, SES email, static sites, SSR apps, cron jobs — define a handler, the infrastructure follows.

## Getting started

```bash
npm install effortless-aws
npm install -D @effortless-aws/cli
```

Full docs, examples, and API reference: **[effortless-aws.website](https://effortless-aws.website)**

## License

MIT
