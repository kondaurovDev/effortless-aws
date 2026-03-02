---
title: HTTP API
description: Build REST APIs with defineHttp and defineApi — routes, validation, database access, and secrets.
---

You need a backend API. Maybe it's a mobile app that fetches data, a webhook endpoint for a third-party service, or a simple CRUD API for your side project. You don't want to set up Express, configure Docker, or manage a server.

With `defineHttp` you write an async function, export it, and get a production endpoint backed by [API Gateway + Lambda](/why-aws/).

## A simple endpoint

You want to return a JSON response at `GET /hello/{name}`.

```typescript
// src/api.ts
import { defineHttp } from "effortless-aws";

export const hello = defineHttp({
  method: "GET",
  path: "/hello/{name}",
  onRequest: async ({ req }) => {
    return {
      status: 200,
      body: { message: `Hello, ${req.params.name}!` },
    };
  },
});
```

After `eff deploy`, you get an API Gateway URL. Every request to `GET /hello/world` runs your function and returns `{ message: "Hello, world!" }`.

The `req` object gives you everything from the HTTP request:
- `req.params` — path parameters (`{name}`)
- `req.query` — query string parameters
- `req.headers` — request headers
- `req.body` — parsed request body (for POST/PUT/PATCH)

## Validating input

Accepting user input without validation is asking for trouble. You want the framework to reject bad requests before your code even runs.

Pass a schema and Effortless validates every request body automatically. Invalid requests get a 400 response — your handler never sees bad data.

```typescript
import { defineHttp } from "effortless-aws";
import { z } from "zod";

export const createUser = defineHttp({
  method: "POST",
  path: "/users",
  schema: (input: unknown) =>
    z.object({
      email: z.string(),
      name: z.string(),
      age: z.number().positive(),
    }).parse(input),
  onRequest: async ({ data }) => {
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

With Effortless, you define the table and reference it in your HTTP handler via `deps`. The framework wires everything — table name, IAM permissions, typed client. Tables use a [single-table design](/use-cases/database/) with a fixed envelope: `pk`, `sk`, `tag`, `data`, and optional `ttl`.

```typescript
// src/tasks.ts
import { defineTable, defineHttp, typed } from "effortless-aws";

type Task = { tag: string; title: string; done: boolean; createdAt: string };

export const tasks = defineTable({
  schema: typed<Task>(),
});

// POST /tasks — create a task
export const createTask = defineHttp({
  method: "POST",
  path: "/tasks",
  deps: { tasks },
  onRequest: async ({ req, deps }) => {
    const id = crypto.randomUUID();
    await deps.tasks.put({
      pk: `TASK#${id}`,
      sk: "DETAIL",
      data: { tag: "task", title: req.body.title, done: false, createdAt: new Date().toISOString() },
    });
    return { status: 201, body: { id, title: req.body.title } };
  },
});

// GET /tasks/{id} — read a task
export const getTask = defineHttp({
  method: "GET",
  path: "/tasks/{id}",
  deps: { tasks },
  onRequest: async ({ req, deps }) => {
    const item = await deps.tasks.get({ pk: `TASK#${req.params.id}`, sk: "DETAIL" });
    if (!item) return { status: 404, body: { error: "Not found" } };
    return { status: 200, body: { id: req.params.id, ...item.data } };
  },
});

// DELETE /tasks/{id} — delete a task
export const deleteTask = defineHttp({
  method: "DELETE",
  path: "/tasks/{id}",
  deps: { tasks },
  onRequest: async ({ req, deps }) => {
    await deps.tasks.delete({ pk: `TASK#${req.params.id}`, sk: "DETAIL" });
    return { status: 200, body: { ok: true } };
  },
});
```

All of this lives in one file. Each Lambda gets only the DynamoDB permissions it needs — `createTask` gets `PutItem`, `getTask` gets `GetItem`, `deleteTask` gets `DeleteItem`. No manual IAM policies.

## Using secrets

Your API calls Stripe, SendGrid, or another service that requires an API key. You don't want to hardcode secrets or manage environment variables.

With `param()`, you reference an SSM Parameter Store key. Effortless fetches the value once at Lambda cold start, caches it, and injects it as a typed argument. IAM permissions for SSM are added automatically.

```typescript
import { defineHttp, param } from "effortless-aws";
import { z } from "zod";

export const checkout = defineHttp({
  method: "POST",
  path: "/checkout",
  config: {
    stripeKey: param("stripe/secret-key"),
  },
  schema: (input: unknown) =>
    z.object({ amount: z.number(), currency: z.string() }).parse(input),
  onRequest: async ({ data, config }) => {
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

## Multiple routes under one API

The examples above use one `defineHttp` per route — each gets its own Lambda. This is fine for a handful of endpoints. But if you're building a CRUD API with many routes, shared setup, and a POST endpoint for commands, consider `defineApi` instead.

### The idea behind defineApi

Traditional REST maps every operation to a different HTTP method and URL: `POST /users`, `GET /users/123`, `PATCH /users/123`, `DELETE /users/123`. This works, but leads to an explosion of routes, each needing its own Lambda, IAM permissions, and API Gateway config.

`defineApi` takes inspiration from **CQRS** (Command Query Responsibility Segregation) and **JSON API** patterns:

- **Reads are GET routes** — simple, cacheable, each with its own path: `/users`, `/users/{id}`
- **Writes are a single POST** — all mutations go through one endpoint as typed JSON commands: `{ action: "create", ... }`, `{ action: "delete", id: "..." }`

Why this works well for serverless:

- **One Lambda instead of many** — shared cold start, shared deps, shared setup. For a CRUD API with 5+ operations, this means fewer Lambdas to deploy and faster cold starts (one function stays warm instead of five)
- **Discriminated unions for commands** — the schema validates the `action` field and narrows the type. Your handler gets a fully typed command with no manual parsing
- **Queries stay separate** — GET routes are individually addressable, cacheable, and easy to reason about
- **Shared context** — database clients, config, and setup code are initialized once and shared across all routes

This isn't a strict CQRS architecture — there's no event sourcing or separate read/write models. It's a pragmatic application of the pattern: split reads and writes, use typed commands for mutations.

### Example

```typescript
import { defineApi } from "effortless-aws";
import { z } from "zod";

const Command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string() }),
  z.object({ action: z.literal("complete"), id: z.string() }),
  z.object({ action: z.literal("delete"), id: z.string() }),
]);

export default defineApi({
  basePath: "/api",
  deps: { tasks },

  get: {
    "/tasks": async ({ deps }) => ({
      status: 200,
      body: await deps.tasks.queryByTag({ tag: "task" }),
    }),
    "/tasks/{id}": async ({ req, deps }) => ({
      status: 200,
      body: await deps.tasks.get({ pk: `TASK#${req.params.id}`, sk: "DETAIL" }),
    }),
  },

  schema: (input) => Command.parse(input),
  post: async ({ data, deps }) => {
    switch (data.action) {
      case "create":
        await deps.tasks.put({ pk: `TASK#${crypto.randomUUID()}`, sk: "DETAIL", data: { tag: "task", title: data.title, done: false } });
        return { status: 201, body: { ok: true } };
      case "complete":
        await deps.tasks.update({ pk: `TASK#${data.id}`, sk: "DETAIL" }, { set: { "data.done": true } });
        return { status: 200, body: { ok: true } };
      case "delete":
        await deps.tasks.delete({ pk: `TASK#${data.id}`, sk: "DETAIL" });
        return { status: 200, body: { ok: true } };
    }
  },
});
```

One Lambda, one deploy, all routes handled. See [Definitions reference — defineApi](/definitions/#defineapi) for the full API.

## See also

- [Definitions reference — defineHttp](/definitions/#definehttp) — all configuration options
- [Definitions reference — defineApi](/definitions/#defineapi) — CQRS-style multi-route API
- [Architecture — Inter-handler dependencies](/architecture/#inter-handler-dependencies-deps) — how deps wiring works
