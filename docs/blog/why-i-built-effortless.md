I'm a software engineer with over 12 years of experience across different languages, teams, and dozens of projects. I love what I do, and I'm drawn to solving real problems with clean tools.

I've been building serverless applications on AWS for years. Across multiple jobs and projects, I've used **Serverless Framework** and **AWS CDK**. And there was always this friction — the gap between having an idea and getting it running in the cloud felt wider than it should be.

This is the story of why I finally snapped and built my own deployment tool — one that skips **CloudFormation** entirely and deploys AWS resources with **direct API calls**.

## The Background

My serverless journey started with **Serverless Framework** — it was the go-to tool at the time, and it worked. Then **AWS CDK** came along promising infrastructure as "real code," and I jumped in. I spent a lot of time with **CDK** commercially, building stacks, configuring resources, trying to get everything just right.

I've also worked with other clouds — **Google Cloud** and **Firebase** in particular. And honestly, **Firebase** left an impression on me. The way you could describe your functions in code, run a single CLI command, and have everything deployed — that felt like how things should work.

That said, I always preferred AWS itself. **Google Cloud** felt overcomplicated — containers everywhere, things weren't obvious. **AWS Lambda** was simpler: no container builds, functions spun up fast, and the whole model just made more sense to me. So I loved **Firebase's** developer experience, but I wanted it on AWS.

## The Pain

With **AWS CDK**, I constantly found myself solving infrastructure puzzles instead of shipping features. How do I split stacks so that Lambda functions deploy faster, separate from the databases? How do I configure bundling — should I use tsup externally, or let CDK handle it? Every project started with the same yak-shaving.

And then there was **CloudFormation**. Every deployment meant waiting for **CloudFormation** to diff, plan, and roll out changes — even for a one-line code fix. For large projects with hundreds of resources, maybe that's an acceptable trade-off. But for serverless, where the whole point is agility, it felt like dragging an anchor.

I wanted a *fast loop*: change code, deploy, see results. Instead, I was spending my time debugging stack configurations and staring at `UPDATE_IN_PROGRESS` for minutes.

## The Inspiration

At some point I discovered something on my own: you can create AWS resources directly through the **AWS SDK**. No **CloudFormation** needed. And it's *much* faster — the end result is exactly the same, but you skip the entire provisioning engine. That was the moment it clicked: combine **Firebase's** code-as-config model with direct **AWS SDK** calls, and you get the best of both worlds.

## What I Built

What if you could just write your Lambda handler, declare its configuration right next to the code, and run a single command to deploy everything? **No CloudFormation templates. No stack definitions. No bundler config. No IAM boilerplate.**

The biggest challenge was clear from the start: I'd need to do what **CloudFormation** does — compare current state with desired state and sync the difference — but without **CloudFormation**, using direct **AWS SDK** calls. That's not a trivial problem.

Three libraries gave me the confidence to try.

**ts-morph** — a fantastic library for analyzing TypeScript AST. It's essentially *metaprogramming*: I could extract all the infrastructure information directly from handler code instead of keeping it in separate YAML or JSON files.

**Effect-TS** — the project was going to be complex, orchestrating API calls, managing errors, handling concurrency. **Effect** gave me a way to write that kind of code without the cognitive load spiraling out of control as the codebase grew.

And a **typed AWS SDK wrapper** I had built a couple of years ago — a generator that reads JSDoc from **AWS SDK** source, extracts all possible error types, and produces **Effect** wrappers where every error is known at the type level.

With these tools in hand, I set out to build **effortless-aws**.

Finding the right API took time. **Firebase** inspired the direction, but I didn't love everything about it. I wanted something where every handler is a single function call that takes one options object — path, method, handler logic, dependencies, parameters, everything in one place. No curried functions, no builder chains. Just one object that's easy to read and extend.

**Effect-TS** inspired me here too — specifically its approach to context and built-in *dependency injection*. In **Effect**, you can verify at the type level that all dependencies are satisfied before running anything. I wanted the same for my handlers: you declare a `setup` factory at the Lambda level, and it's injected into every request handler with full type safety. No runtime surprises where something is undefined because you forgot to wire it up.

This matters because some handlers need references to other resources — a Lambda that writes to a DynamoDB table, for example. A single config object makes that natural: you just add a `deps` field. Everything — setup, deps, params — is *type-checked* and injected automatically.

Here's what the simplest handler looks like:

```typescript
import { defineHttp } from "effortless-aws";

export const hello = defineHttp({
  method: "GET",
  path: "/hello",
  onRequest: async ({ req }) => ({
    status: 200,
    body: { message: "Hello World!" },
  }),
});
```

That's your **Lambda** function, its **API Gateway** route, and its **IAM** role — all in one file. Run `eff deploy` and it's live.

## Before and After

To appreciate the difference, here's what it takes to create a simple HTTP endpoint with a DynamoDB table in CDK:

```typescript
// CDK: stack definition (separate file)
const table = new dynamodb.Table(this, "Orders", {
  partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

const fn = new nodejs.NodejsFunction(this, "GetOrders", {
  entry: "src/handlers/get-orders.ts",
  runtime: lambda.Runtime.NODEJS_20_X,
  environment: { TABLE_NAME: table.tableName },
  bundling: { minify: true, sourceMap: true },
});

table.grantReadData(fn);

const api = new apigateway.HttpApi(this, "Api");
api.addRoutes({
  path: "/orders",
  methods: [apigateway.HttpMethod.GET],
  integration: new HttpLambdaIntegration("GetOrdersIntegration", fn),
});
```

That's just the infrastructure. You still need the handler file, the stack wiring, the app entry point, and `cdk deploy` with **CloudFormation**.

With **effortless-aws**, the same thing is:

```typescript
// That's it. One file.
import { defineHttp, defineTable } from "effortless-aws";

export const orders = defineTable({
  pk: "id",
});

export const getOrders = defineHttp({
  method: "GET",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ deps }) => {
    const items = await deps.orders.scan();
    return { status: 200, body: items };
  },
});
```

Run `eff deploy`. Done. The table, the function, the route, the IAM permissions — all created in **seconds**.

## How It Works

Under the hood, `eff deploy` goes through four stages. Orchestrating them was the hardest part of the project — each stage feeds into the next, errors can happen anywhere, and resources depend on each other. **Effect-TS** made this manageable: the whole pipeline is composable, each step is an **Effect** you can reason about independently.

### 1. Scan

**ts-morph** reads your TypeScript source and extracts every `defineHttp` / `defineTable` call — method, path, deps, params, static files — straight from the AST. This was the part where I realized *metaprogramming* in TypeScript is actually viable. Instead of maintaining separate YAML or JSON config files, **the code itself is the source of truth**. **ts-morph** made it surprisingly elegant.

### 2. Bundle

**esbuild** compiles each handler into a single ESM file. I had experience with **esbuild** before — it's fast and does its job well. But I also wanted to solve the dependency problem: in a project with many Lambda functions, they usually share the same production dependencies. Bundling `node_modules` into every handler ZIP felt wasteful. So I put shared dependencies into a **Lambda Layer** — one layer for the whole project. Each handler bundles into a clean single JS file, and the layer provides `node_modules` at runtime. This was its own challenge to get right, but it works reliably — at least with `pnpm` projects so far.

### 3. Diff

The tool checks what already exists in AWS and compares it with what your code declares. Only the differences get applied. This is essentially what **CloudFormation** does — syncing desired state with current state — but without the provisioning engine overhead. Getting this right was the biggest conceptual challenge: figuring out the right granularity of comparison and making sure updates are idempotent.

### 4. Deploy

Direct **AWS SDK** calls create, update, or reconfigure resources — **Lambda** functions, **DynamoDB** tables, **API Gateway** routes, **IAM** policies. Because every AWS call goes through the typed **Effect** wrappers, every possible error is known. If a function already exists — I log it and move on. If there's an internal AWS error — I stop the deploy. No guesswork, no catch-all try/catch blocks.

## Try It Out

**effortless-aws** is currently in alpha. It works — I'm using it myself to deploy real projects: the documentation website, and a couple of personal projects that use Lambda functions, DynamoDB tables, streams, and triggers. Everything deploys and runs. But it's still in active development: there may be rough edges, and I'm constantly testing and fixing things.

The roadmap is full of features I want to add, and the project is evolving fast. I've put together a website with documentation that covers what's available today — handlers for Lambda functions, DynamoDB tables, static websites, and more.

```bash
npm install effortless-aws
```

- [GitHub](https://github.com/effect-ak/effortless)
- [Website & Docs](https://effortless-aws.website)

**Tools I used to build this:**

- [Effect-TS](https://effect.website) — typed functional programming for TypeScript
- [ts-morph](https://github.com/dsherret/ts-morph) — TypeScript AST analysis and manipulation
- [esbuild](https://esbuild.github.io) — fast JavaScript/TypeScript bundler
- [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) — official AWS SDK v3
- [Typed AWS SDK wrapper](https://github.com/kondaurovDev/aws-sdk) — Effect wrappers with typed errors for AWS SDK

I'm confident in the ideas behind this project and I'll keep building it. If you're a developer who wants to ship faster — to spend your time solving real problems instead of writing infrastructure config — give it a look. I'd love your feedback.
