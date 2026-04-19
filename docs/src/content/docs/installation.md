---
title: Installation
description: Install effortless-aws, set up credentials, and deploy your first handler.
---

## Install

```bash
# Runtime library — add to your project
npm install effortless-aws

# CLI — install globally (recommended)
npm install -g @effortless-aws/cli
```

Or use the CLI without installing globally via `npx eff`.

## AWS Credentials

Effortless deploys directly to your AWS account using the AWS SDK. You need working credentials before running `eff deploy`.

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
The IAM user or role needs permissions to manage Lambda, DynamoDB, IAM roles, S3, SQS, CloudFront, and SSM. `AdministratorAccess` is simplest for development — scope it down for production.
:::

:::note[Coming soon]
A [Control Plane Lambda](/roadmap#control-plane--web-dashboard) is planned that will handle deploys inside your AWS account — no local credentials needed. One-time setup, then developers only need an API key.
:::

## First deploy

### 1. Create config file

```typescript
// effortless.config.ts
import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "my-service",
  region: "eu-central-1",
  handlers: ["src/**/*.ts"],
});
```

### 2. Define a handler

```typescript
// src/api.ts
import { defineApi } from "effortless-aws";

export const hello = defineApi({ basePath: "/hello" })
  .get({ path: "/" }, async () => ({
    status: 200,
    body: { message: "Hello from Effortless!" },
  }));
```

### 3. Deploy

```bash
eff deploy
```

That's it. Lambda + Function URL + IAM role created in ~10 seconds.

## Next steps

- [Definitions](/definitions/) — all definition types and their options
- [Configuration](/configuration/) — project and per-handler config
- [CLI](/cli/) — available commands
