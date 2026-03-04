---
title: HTTP API
description: Build REST APIs with defineApi — routes, validation, database access, and secrets.
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
  get: {
    "/{name}": async ({ req }) => ({
      status: 200,
      body: { message: `Hello, ${req.params.name}!` },
    }),
  },
});
```

After `eff deploy`, you get a Function URL. Every request to `GET /hello/world` runs your function and returns `{ message: "Hello, world!" }`.

The `req` object gives you everything from the HTTP request:
- `req.params` — path parameters (`{name}`)
- `req.query` — query string parameters
- `req.headers` — request headers
- `req.body` — parsed request body (for POST/PUT/PATCH)

## Validating input

Accepting user input without validation is asking for trouble. You want the framework to reject bad requests before your code even runs.

Pass a `schema` and Effortless validates every request body automatically. Invalid requests get a 400 response — your handler never sees bad data.

```typescript
import { defineApi } from "effortless-aws";
import { z } from "zod";

export const users = defineApi({
  basePath: "/users",
  schema: (input: unknown) =>
    z.object({
      email: z.string(),
      name: z.string(),
      age: z.number().positive(),
    }).parse(input),
  post: async ({ data }) => {
    // data is typed: { email: string, name: string, age: number }
    // already validated — no need for manual checks
    return {
      status: 201,
      body: { id: crypto.randomUUID(), ...data },
    };
  },
});
```

The `data` argument is typed from your schema. Send `{ "email": 123 }` and the caller gets a 400 with a clear validation error. Your handler only runs when the data is correct.

## CRUD with a database

Most APIs need a database. Traditionally that means: create a DynamoDB table in CloudFormation, configure IAM permissions for the Lambda to access it, pass the table name via environment variables, instantiate the DynamoDB client, and write untyped SDK calls.

With Effortless, you define the table and reference it in your API handler via `deps`. The framework wires everything — table name, IAM permissions, typed client. Tables use a [single-table design](/use-cases/database/) with a fixed envelope: `pk`, `sk`, `tag`, `data`, and optional `ttl`.

```typescript
// src/tasks.ts
import { defineTable, defineApi, typed } from "effortless-aws";
import { z } from "zod";

type Task = { tag: string; title: string; done: boolean; createdAt: string };

export const tasks = defineTable({
  schema: typed<Task>(),
});

const Command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string() }),
  z.object({ action: z.literal("complete"), id: z.string() }),
  z.object({ action: z.literal("delete"), id: z.string() }),
]);

export default defineApi({
  basePath: "/tasks",
  deps: { tasks },

  get: {
    "/": async ({ deps }) => ({
      status: 200,
      body: await deps.tasks.query({ pk: "TASKS", sk: { begins_with: "TASK#" } }),
    }),
    "/{id}": async ({ req, deps }) => {
      const item = await deps.tasks.get({ pk: `TASK#${req.params.id}`, sk: "DETAIL" });
      if (!item) return { status: 404, body: { error: "Not found" } };
      return { status: 200, body: { id: req.params.id, ...item.data } };
    },
  },

  schema: (input) => Command.parse(input),
  post: async ({ data, deps }) => {
    switch (data.action) {
      case "create": {
        const id = crypto.randomUUID();
        await deps.tasks.put({
          pk: `TASK#${id}`, sk: "DETAIL",
          data: { tag: "task", title: data.title, done: false, createdAt: new Date().toISOString() },
        });
        return { status: 201, body: { id, title: data.title } };
      }
      case "complete": {
        await deps.tasks.update({ pk: `TASK#${data.id}`, sk: "DETAIL" }, { set: { done: true } });
        return { status: 200, body: { ok: true } };
      }
      case "delete": {
        await deps.tasks.delete({ pk: `TASK#${data.id}`, sk: "DETAIL" });
        return { status: 200, body: { ok: true } };
      }
    }
  },
});
```

All of this lives in one file, one Lambda. The framework auto-wires DynamoDB permissions — `PutItem`, `GetItem`, `DeleteItem`, `UpdateItem`, `Query` — only what's needed. No manual IAM policies.

### Why one Lambda for all routes?

`defineApi` deploys a single Lambda that handles routing internally. This means:

- **Shared cold start** — one function stays warm instead of many
- **Shared deps** — database clients, config, and setup code initialized once
- **Fewer resources** — one Lambda, one Function URL, one IAM role
- **Simpler deploys** — one bundle to build and upload

GET routes are individually addressable and cacheable. POST handles all mutations via typed commands — a pragmatic CQRS pattern.

## Using secrets

Your API calls Stripe, SendGrid, or another service that requires an API key. You don't want to hardcode secrets or manage environment variables.

With `param()`, you reference an SSM Parameter Store key. Effortless fetches the value once at Lambda cold start, caches it, and injects it as a typed argument. IAM permissions for SSM are added automatically.

```typescript
import { defineApi, param } from "effortless-aws";
import { z } from "zod";

export const payments = defineApi({
  basePath: "/payments",
  config: {
    stripeKey: param("stripe/secret-key"),
  },
  schema: (input: unknown) =>
    z.object({ amount: z.number(), currency: z.string() }).parse(input),
  post: async ({ data, config }) => {
    // config.stripeKey is fetched from SSM, cached across invocations
    const stripe = new Stripe(config.stripeKey);
    const intent = await stripe.paymentIntents.create({
      amount: data.amount,
      currency: data.currency,
    });
    return { status: 200, body: { clientSecret: intent.client_secret } };
  },
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
