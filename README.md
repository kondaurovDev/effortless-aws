# effortless-aws

[![npm version](https://img.shields.io/npm/v/effortless-aws)](https://www.npmjs.com/package/effortless-aws)
[![npm downloads](https://img.shields.io/npm/dm/effortless-aws)](https://www.npmjs.com/package/effortless-aws)

TypeScript framework for AWS serverless. Export handlers, deploy with one command. No YAML, no CloudFormation, no state files.

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

```bash
npx eff deploy
```

One export, one command. Lambda, API Gateway route, and IAM role created automatically.

## Features

- **Infrastructure from code** — export a handler, get the AWS resources. No config files.
- **Typed everything** — `defineTable<Order>` gives you typed `put()`, typed `deps.orders.get()`, typed `record.new`.
- **Direct AWS SDK deploys** — no CloudFormation. Deploy in ~5-10s, not minutes.
- **No state files** — AWS resource tags are the source of truth.
- **Cross-handler deps** — `deps: { orders }` auto-wires IAM and injects a typed `TableClient`.
- **SSM params** — `param("stripe-key")` fetches from Parameter Store at cold start. Auto IAM, auto caching.
- **Partial batch failures** — DynamoDB stream processing reports failed records individually.
- **Cold start caching** — `context` factory runs once per cold start, cached across invocations.

## Documentation

Full docs, examples, and API reference: **[effortless-aws docs](https://effortless-aws.website)**

## License

MIT
