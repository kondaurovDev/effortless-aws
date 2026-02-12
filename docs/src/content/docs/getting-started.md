---
title: Getting Started
description: Export handlers, deploy to AWS. No infrastructure files needed.
---

## Motivation

Current AWS Lambda development requires separating infrastructure (CloudFormation, CDK, Terraform) from application code. This creates friction:

- Infrastructure and handlers live in different places
- Adding a new Lambda requires changes in multiple files
- Configuration (memory, timeout, permissions) is disconnected from the code that uses it

**Goal**: Define Lambda handlers in code, deploy with one command.

## Inspiration

Inspired by Firebase Functions where you export handlers and infrastructure is derived from code.

## Core Principles

1. **Infrastructure from code** - export a handler, get the Lambda + resources automatically
2. **TypeScript-first** - full type safety, no YAML/JSON configs
3. **Simple API** - async functions, no framework lock-in
4. **Effect inside** - use Effect internally for reliability, but don't require it from users
5. **AWS SDK direct** - no CDK/CloudFormation abstraction layers

## Built-in Best Practices

Effortless is not just a deployment tool — it bakes serverless best practices directly into the framework so you don't have to think about them.

Inspired by [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/), effortless takes the patterns that every production Lambda needs and makes them automatic or trivially easy to add.

### What's already built in

- **Partial batch failures** — when processing SQS messages or DynamoDB streams, failed records are reported individually. The batch doesn't fail entirely because of one bad record. No code needed — it just works.
- **Typed event parsing** — request bodies, stream records, and queue messages are parsed and validated via Effect Schema before your handler sees them. No manual `JSON.parse` + type casting.
- **Cold start optimization** — the `context` factory runs once on cold start and is cached across invocations. Put your DB connections, SDK clients, and config loading there.
- **Infrastructure as code, not config** — permissions, triggers, and resources are derived from your handler definition. Add `onRecord` to a table — effortless creates the stream, Lambda, and event source mapping automatically.

### What's on the roadmap

Some of these ideas are inspired by [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/) — a great runtime toolkit for Lambda. Effortless takes a different angle: since it controls both the runtime and the infrastructure, it can wire things end-to-end (e.g. auto-create a DynamoDB table for idempotency, or auto-add IAM permissions when you reference an SSM parameter).

See [Roadmap](./roadmap) for the full list of planned features.

## Installation

```bash
npm install effortless-aws
```

## AWS Credentials

Effortless deploys directly to your AWS account using the AWS SDK. You need working credentials before running `npx eff deploy`.

Any standard AWS credential method works:

- **`~/.aws/credentials`** — static access keys (simplest for local dev)
- **Environment variables** — `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
- **SSO** — `aws sso login` if your org uses IAM Identity Center
- **IAM role** — for CI/CD environments (GitHub Actions, etc.)

Verify with:

```bash
aws sts get-caller-identity
```

:::caution
The IAM user or role needs permissions to manage Lambda, API Gateway, DynamoDB, IAM roles, and SSM. `AdministratorAccess` is simplest for development — scope it down for production.
:::

:::note[Coming soon]
A [Control Plane Lambda](/roadmap#control-plane--web-dashboard) is planned that will handle deploys inside your AWS account — no local credentials needed. One-time setup, then developers only need an API key.
:::

## Quick Start

### 1. Create config file

```typescript
// effortless.config.ts
import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "my-service",
  region: "eu-central-1",
  handlers: ["src/**/*.ts"],  // scan all .ts files in src/

  defaults: {
    memory: 256,
    timeout: "30 seconds",
    runtime: "nodejs22.x",
  },
});
```

### 2. Define handlers

```typescript
// src/expenses.ts
import { defineQueue, defineHttp, defineSchedule } from "effortless-aws";
import { Schema } from "effect";

// Queue handler - creates SQS queue + Lambda + event source mapping
export const processExpenses = defineQueue({
  memory: 512,
  batchSize: 10,
  visibilityTimeout: "2 minutes",
  messageSchema: Schema.Struct({
    price: Schema.Number,
    what: Schema.String,
  }),
  handler: async (messages, ctx) => {
    for (const msg of messages) {
      console.log(`Processing: ${msg.what} - ${msg.price}`);
      // your logic here
    }
  }
});

// HTTP handler - creates API Gateway + Lambda
export const getExpenses = defineHttp({
  method: "GET",
  path: "/api/expenses",
  onRequest: async ({ req }) => {
    const expenses = await fetchExpenses();
    return {
      status: 200,
      body: expenses,
    };
  }
});

// Schedule handler - creates EventBridge rule + Lambda
export const dailyReport = defineSchedule({
  schedule: "rate(1 day)", // or cron expression
  handler: async (ctx) => {
    await generateAndSendReport();
  }
});
```

### 3. Deploy

```bash
npx effortless deploy
# or short version
npx eff deploy
```

## Next Steps

- [Handlers](./handlers) - All handler types (defineQueue, defineHttp, defineSchedule, defineEvent, defineS3, defineTable)
- [Configuration](./configuration) - Project and per-handler configuration
- [CLI](./cli) - Available CLI commands
- [Architecture](./architecture) - How it works under the hood
- [FAQ](./faq) - Why AWS, why not CloudFormation, etc.
- [Roadmap](./roadmap) - Planned features (idempotency, parameters, logger, metrics, tracing, middleware)
