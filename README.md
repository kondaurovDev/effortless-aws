# effortless-aws

[![npm version](https://img.shields.io/npm/v/effortless-aws)](https://www.npmjs.com/package/effortless-aws)
[![npm downloads](https://img.shields.io/npm/dw/effortless-aws)](https://www.npmjs.com/package/effortless-aws)

**Write a TypeScript handler. Export it. Deploy. That's it.**

No CloudFormation. No Terraform. No YAML. No state files. Lambda, DynamoDB, IAM — all created from your code in ~10 seconds.

## The problem

Adding one Lambda endpoint with existing tools:

1. Write the handler
2. Define Lambda in CloudFormation / CDK / SST / Terraform
3. Create an IAM role with the right permissions
4. Wire up API Gateway route
5. Configure environment variables
6. Wait 2-5 minutes for CloudFormation

**Six steps, five files, one endpoint.**

## With Effortless

```typescript
// src/api.ts
import { defineApi } from "effortless-aws";

export const hello = defineApi({
  basePath: "/hello",
  get: {
    "/": async () => ({
      status: 200,
      body: { message: "Hello!" },
    }),
  },
});
```

```bash
npx eff deploy   # ~10 seconds
```

One file. One command. Lambda + Function URL + IAM role created automatically.

## A more real example

```typescript
import { defineTable, defineApi, typed } from "effortless-aws";

type Order = { id: string; product: string; amount: number };

// Creates a DynamoDB table + stream processor Lambda
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    console.log("New order:", record.new!.product);
  },
});

// Creates an HTTP Lambda with DynamoDB write permissions
export const api = defineApi({
  basePath: "/orders",
  deps: { orders },
  post: async ({ req, deps }) => {
    await deps.orders.put({           // typed client — knows Order shape
      id: crypto.randomUUID(),
      product: req.body.product,
      amount: req.body.amount,
    });
    return { status: 201, body: { ok: true } };
  },
});
```

This creates: DynamoDB table, stream processor Lambda, HTTP Lambda, Function URL, IAM roles for both, environment variable wiring. **Zero config files.**

## What's in the box

- **`defineApi`** — HTTP API with typed GET/POST routes via Lambda Function URL
- **`defineApp`** — SSR frameworks (Nuxt, Astro) via CloudFront + Lambda
- **`defineTable`** — DynamoDB tables with typed clients and stream processing
- **`defineFifoQueue`** — SQS FIFO queue consumers
- **`defineBucket`** — S3 buckets with event triggers
- **`defineMailer`** — SES email sending
- **`defineStaticSite`** — CloudFront + S3 static sites

**Cross-handler deps** — `deps: { orders }` auto-wires IAM and injects a typed `TableClient`.

**SSM params** — `param("stripe-key")` fetches secrets from Parameter Store at cold start. Auto IAM, auto caching.

## Packages

| Package | What it does |
|---------|-------------|
| [`effortless-aws`](https://www.npmjs.com/package/effortless-aws) | Handler definitions and runtime |
| [`@effortless-aws/cli`](https://www.npmjs.com/package/@effortless-aws/cli) | Build, deploy, logs, cleanup |

```bash
npm install effortless-aws
npm install -D @effortless-aws/cli
```

## Documentation

**[effortless-aws.website](https://effortless-aws.website)**

## License

MIT
