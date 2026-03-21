---
title: Configuration
description: Project and per-handler configuration options.
---

Every Effortless project starts with a config file in the project root. This is where you set the project name, AWS region, and tell Effortless where to find your handlers.

## Overview

Create `effortless.config.ts` at the root of your project and export a default config using `defineConfig`:

```typescript
// effortless.config.ts
import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "my-service",
  region: "eu-central-1",
  handlers: ["src/**/*.ts"],
});
```

That's the minimum — a name, a region, and a pattern to find handlers. Effortless will discover all `defineApi`, `defineTable`, `defineFifoQueue`, and other handler exports in matching files.

## Project Config

### `name` (required)

The project name is used as a prefix for all AWS resources: Lambda functions, DynamoDB tables, SQS queues, IAM roles, etc.

For example, with `name: "orders"` and stage `dev`, a handler named `createOrder` becomes `orders-dev-createOrder` in AWS.

Choose a short, unique name — changing it later means redeploying everything.

```typescript
name: "orders"
```

### `region`

AWS region where all resources will be created.

```typescript
region: "eu-central-1"    // default
```

Can be overridden per deploy with `eff deploy --region us-east-1`.

### `stage`

Deployment stage for resource isolation. Each stage gets its own set of resources — different Lambda functions, different DynamoDB tables, different queues.

```typescript
stage: "dev"              // default
```

Override per deploy with `eff deploy --stage prod`. This lets you run multiple environments in the same AWS account without conflicts.

### `root`

Project root directory. All relative paths (handler patterns, static files, etc.) are resolved from this directory.

```typescript
root: ".."   // resolve handlers from the parent directory
```

Useful in **monorepo setups** where `effortless.config.ts` lives in a subdirectory (e.g., `infra/`) but handler files are elsewhere:

```
monorepo/
  src/
    handlers/
      api.ts
  infra/
    effortless.config.ts    ← root: ".."
    package.json            ← dependencies for the Lambda layer
```

```typescript
// infra/effortless.config.ts
export default defineConfig({
  name: "my-service",
  root: "..",                          // resolve paths from monorepo root
  handlers: ["src/handlers/**/*.ts"],  // relative to root
});
```

**Important:** `root` only affects handler file resolution. The Lambda layer reads `package.json` and `node_modules` from the directory where you run the CLI (`cwd`), not from `root`. This means your runtime dependencies should be in `infra/package.json`, not in the monorepo root.

Default: `"."` (current working directory).

### `handlers`

Glob patterns or directory paths to scan for handler exports. Used by `eff deploy` (without a file argument) to auto-discover all handlers.

```typescript
// Single directory — scans for all .ts files
handlers: "src"

// Multiple patterns
handlers: ["src/**/*.ts", "lib/**/*.handler.ts"]
```

If you pass a file directly to the CLI (`eff deploy src/api.ts`), only that file is deployed — regardless of this setting.

### `defaults`

Default Lambda settings applied to all handlers. Individual handlers can override any of these.

```typescript
defaults: {
  memory: 256,             // MB (AWS range: 128–10240)
  timeout: "30 seconds",   // human-readable, e.g. "5 minutes"
  runtime: "nodejs24.x",
}
```

| Option | Default | Why |
|--------|---------|-----|
| `memory` | `256` | Enough for most API handlers and stream processors. AWS allocates CPU proportionally — more memory means more CPU. |
| `timeout` | `"30 seconds"` | Covers typical API calls and background tasks. AWS maximum is 15 minutes. |
| `runtime` | `"nodejs24.x"` | Latest Node.js LTS available in Lambda. Faster cold starts and better performance than older versions. |

:::tip
For CPU-intensive handlers (image processing, PDF generation), increase `memory` — AWS allocates proportional CPU. 1769 MB gives you one full vCPU.
:::

### Architecture

All Lambdas run on **ARM64** (AWS Graviton2) by default. Graviton2 is ~20% cheaper than x86_64 and offers better price-performance for most Node.js workloads. This is not configurable — there's no reason to use x86 for new Lambda functions.

## Full Example

```typescript
// effortless.config.ts
import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "my-service",
  root: "..",                   // optional, for monorepo setups
  region: "eu-central-1",
  stage: "dev",
  handlers: ["src/**/*.ts"],
  defaults: {
    memory: 256,
    timeout: "30 seconds",
    runtime: "nodejs24.x",
  },
});
```

## Per-handler Overrides

Every handler accepts `memory`, `timeout`, and `permissions` to override project defaults. You can also add IAM permissions for specific AWS services a handler needs to access.

```typescript
import { defineApi } from "effortless-aws";

export const processImage = defineApi({
  basePath: "/images",
  memory: 1024,                    // needs more memory for image processing
  timeout: 120,                    // 2 minutes (in seconds)
  permissions: ["s3:GetObject", "s3:PutObject"],
})
  .post("/resize", async ({ req }) => {
    // ...
  });
```

### `memory` and `timeout`

Override the project defaults for a specific handler. Timeout is in **seconds** at the handler level (unlike the config file which uses human-readable strings).

### `permissions`

Additional IAM permissions for the Lambda's execution role. Use the `service:action` shorthand:

```typescript
permissions: [
  "s3:GetObject",
  "s3:PutObject",
  "ses:SendEmail",
]
```

These are added on top of any permissions Effortless manages automatically (e.g., DynamoDB access for `deps`, SSM access for `params`).

:::note
Effortless auto-manages permissions for built-in features. You only need `permissions` for AWS services you call directly in your handler code.
:::

### `logLevel`

Controls the verbosity of structured logs emitted to CloudWatch. Defaults to `"info"` for `defineApi`, `defineTable`, and `defineFifoQueue`.

| Level | What gets logged |
|-------|-----------------|
| `"error"` | Only errors (`console.error`) |
| `"info"` | Errors + execution summary (handler, type, duration) |
| `"debug"` | Info + input/output args (truncated) |

```typescript
logLevel: "debug"   // log everything including input/output
```

Developer `console.*` calls are also filtered by this level — `console.debug()` is suppressed at `"info"`, and `console.log()`/`console.info()` are suppressed at `"error"`. `console.error` and `console.warn` always pass through.
