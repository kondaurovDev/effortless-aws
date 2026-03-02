# effortless-aws

[![npm version](https://img.shields.io/npm/v/effortless-aws)](https://www.npmjs.com/package/effortless-aws)

Code-first AWS Lambda framework. Export handlers, deploy with one command. No YAML, no CloudFormation, no state files.

```bash
npm install effortless-aws
```

## What it looks like

```typescript
import { defineHttp } from "effortless-aws";

export const hello = defineHttp({
  method: "GET",
  path: "/hello",
  onRequest: async () => {
    return { status: 200, body: { message: "Hello!" } };
  },
});
```

## Handlers

| Handler | Description |
|---------|-------------|
| `defineHttp` | HTTP endpoint via API Gateway |
| `defineApi` | REST API with typed GET/POST routes |
| `defineApp` | Generic Lambda (cron, custom events) |
| `defineTable` | DynamoDB table with stream processing |
| `defineFifoQueue` | SQS FIFO queue consumer |
| `defineBucket` | S3 bucket with event triggers |
| `defineMailer` | SES email sending |
| `defineStaticSite` | CloudFront + S3 static site with optional middleware |

## Features

- **Infrastructure from code** — export a handler, get the AWS resources
- **Typed everything** — `defineTable<Order>` gives you typed `put()`, typed `deps.orders.get()`, typed `record.new`
- **Cross-handler deps** — `deps: { orders }` auto-wires IAM and injects a typed `TableClient`
- **SSM params** — `param("stripe-key")` fetches from Parameter Store at cold start
- **Static files** — `static: ["templates/*.ejs"]` bundles files into the Lambda ZIP
- **Cold start caching** — `setup` factory runs once per cold start, cached across invocations

Deploy with [`@effortless-aws/cli`](https://www.npmjs.com/package/@effortless-aws/cli).

## Documentation

Full docs, examples, and API reference: **[effortless-aws.website](https://effortless-aws.website)**

## License

MIT
