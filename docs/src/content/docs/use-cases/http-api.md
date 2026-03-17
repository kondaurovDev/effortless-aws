---
title: HTTP API
description: Build REST APIs with defineApi — routes, database access, and secrets.
---

You need a backend API. Maybe it's a mobile app that fetches data, a webhook endpoint for a third-party service, or a simple CRUD API for your side project. You don't want to set up Express, configure Docker, or manage a server.

With `defineApi` you declare your routes, export the handler, and get a production endpoint backed by a [Lambda Function URL](/why-serverless/). One Lambda handles all your routes — no API Gateway, no per-route config.

## A simple endpoint

You want to return a JSON response at `GET /hello/{name}`.

```typescript
// src/api.ts
import { defineApi } from "effortless-aws";

export const hello = defineApi({
  basePath: "/hello",
  routes: [
    {
      path: "GET /{name}",
      onRequest: async ({ req }) => ({
        status: 200,
        body: { message: `Hello, ${req.params.name}!` },
      }),
    },
  ],
});
```

After `eff deploy`, you get a Function URL. Every request to `GET /hello/world` runs your function and returns `{ message: "Hello, world!" }`.

The `req` object gives you everything from the HTTP request:
- `req.params` — path parameters (`{name}`)
- `req.query` — query string parameters
- `req.headers` — request headers

For POST/PUT/PATCH routes, the parsed request body is available as `input`.

## CRUD with a database

Most APIs need a database. Traditionally that means: create a DynamoDB table in CloudFormation, configure IAM permissions for the Lambda to access it, pass the table name via environment variables, instantiate the DynamoDB client, and write untyped SDK calls.

With Effortless, you define the table and reference it in your API handler via `deps`. The framework wires everything — table name, IAM permissions, typed client. Tables use a [single-table design](/use-cases/database/) with a fixed envelope: `pk`, `sk`, `tag`, `data`, and optional `ttl`.

Use `setup` to initialize shared resources once at cold start. Whatever `setup` returns is spread directly into every route handler's arguments.

```typescript
// src/tasks.ts
import { defineTable, defineApi, unsafeAs } from "effortless-aws";

type Task = { tag: string; title: string; done: boolean; createdAt: string };

export const tasks = defineTable({
  schema: unsafeAs<Task>(),
});

export default defineApi({
  basePath: "/tasks",
  deps: () => ({ tasks }),
  setup: ({ deps }) => ({ tasks: deps.tasks }),
  routes: [
    {
      path: "GET /",
      onRequest: async ({ tasks }) => ({
        status: 200,
        body: await tasks.query({ pk: "TASKS", sk: { begins_with: "TASK#" } }),
      }),
    },
    {
      path: "GET /{id}",
      onRequest: async ({ req, tasks }) => {
        const item = await tasks.get({ pk: `TASK#${req.params.id}`, sk: "DETAIL" });
        if (!item) return { status: 404, body: { error: "Not found" } };
        return { status: 200, body: { id: req.params.id, ...item.data } };
      },
    },
    {
      path: "POST /create",
      onRequest: async ({ input, tasks }) => {
        const { title } = input as { title: string };
        const id = crypto.randomUUID();
        await tasks.put({
          pk: `TASK#${id}`, sk: "DETAIL",
          data: { tag: "task", title, done: false, createdAt: new Date().toISOString() },
        });
        return { status: 201, body: { id, title } };
      },
    },
  ],
});
```

All of this lives in one file, one Lambda. The framework auto-wires DynamoDB permissions — `PutItem`, `GetItem`, `DeleteItem`, `UpdateItem`, `Query` — only what's needed. No manual IAM policies.

Notice that `deps` and `config` are only available inside `setup`, not in individual route handlers. The `setup` function returns an object whose properties are spread into every route handler's arguments alongside `req` and `input`.

### Why one Lambda for all routes?

`defineApi` deploys a single Lambda that handles routing internally. This means:

- **Shared cold start** — one function stays warm instead of many
- **Shared setup** — database clients, config, and setup code initialized once
- **Fewer resources** — one Lambda, one Function URL, one IAM role
- **Simpler deploys** — one bundle to build and upload

Each route is defined with an HTTP method and path in the `path` field (e.g. `"GET /users"`, `"POST /create"`), and routing is handled internally.

## Using secrets

Your API calls Stripe, SendGrid, or another service that requires an API key. You don't want to hardcode secrets or manage environment variables.

With `param()`, you reference an SSM Parameter Store key. Effortless fetches the value once at Lambda cold start, caches it, and injects it via `setup`. IAM permissions for SSM are added automatically.

```typescript
import { defineApi, param } from "effortless-aws";

export const payments = defineApi({
  basePath: "/payments",
  config: {
    stripeKey: param("stripe/secret-key"),
  },
  setup: ({ config }) => ({ stripeKey: config.stripeKey }),
  routes: [
    {
      path: "POST /charge",
      onRequest: async ({ input, stripeKey }) => {
        const { amount, currency } = input as { amount: number; currency: string };
        // stripeKey is fetched from SSM at cold start, cached across invocations
        const stripe = new Stripe(stripeKey);
        const intent = await stripe.paymentIntents.create({ amount, currency });
        return { status: 200, body: { clientSecret: intent.client_secret } };
      },
    },
  ],
});
```

Create the secret in SSM using the CLI:

```bash
eff config set stripe/secret-key --stage dev
```

Or manually: `aws ssm put-parameter --name /my-service/dev/stripe/secret-key --value sk_test_... --type SecureString`.

Effortless reads parameters at `/${project}/${stage}/${key}`. If you forget to create a parameter, `eff deploy` will warn you about missing values.

## See also

- [Definitions reference — defineApi](/definitions/#defineapi) — all configuration options
- [Architecture — Inter-handler dependencies](/architecture/#inter-handler-dependencies-deps) — how deps wiring works
