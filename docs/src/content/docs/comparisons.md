---
title: Comparisons
description: How Effortless compares to CloudFormation, SST, Nitric, Alchemy, Terraform, and other deployment tools.
---

## Why Not CloudFormation?

### The Problem with Abstraction Layers

Most AWS deployment tools follow this pattern:

```
Your Code → YAML/JSON Config → CloudFormation → AWS API
```

Each layer adds:
- **Latency**: CloudFormation stack operations take minutes, even for simple changes
- **Complexity**: Debugging requires understanding multiple abstraction levels
- **State drift**: Template state can diverge from actual AWS state
- **Vendor lock-in**: Your infrastructure is tied to CloudFormation's model

### Effortless approach: Direct AWS SDK Calls

```
Your Code → AWS SDK → AWS API
```

**No intermediary.** Effortless calls the same APIs that CloudFormation calls, but directly.

### Speed Comparison

| Operation | CloudFormation | Effortless |
|-----------|----------------|------------|
| Create Lambda | 60-120s | 5-10s |
| Update Lambda code | 30-60s | 3-5s |
| Create API Gateway | 60-90s | 2-3s |
| Full redeploy | 5-10 min | 30-60s |

CloudFormation is slow because:
1. It validates the entire stack template
2. It creates a change set
3. It executes changes sequentially with rollback capability
4. It waits for each resource to stabilize

Effortless is fast because:
1. Direct API calls
2. Independent operations run in parallel
3. `ensure*` pattern — check existence, create or update

### Imperative vs Declarative

**CloudFormation (declarative):**
> "Here's my desired state. Figure out how to get there."

**Effortless (imperative):**
> "Check if this exists. If not, create it. If yes, update it."

Declarative sounds elegant, but requires:
- Complex diffing algorithms
- State tracking and reconciliation
- Rollback mechanisms
- Dependency graph resolution

The imperative approach is:
- Predictable - you know exactly what will happen
- Debuggable - each API call is visible
- Fast - no diff calculation, no rollback overhead
- Simple - ~50 lines per resource type vs thousands in CDK constructs

### Tags as State (Not Files)

**Traditional tools** store state in:
- Local files (Terraform `tfstate`)
- S3 buckets (Terraform remote backend)
- DynamoDB (CDK)
- CloudFormation stacks

**Problems:**
- State can drift from reality
- Team coordination requires locking
- Lost state = orphaned resources or duplicates
- Another thing to manage and back up

**Effortless approach:** AWS tags ARE the state.

```
effortless:project = my-app
effortless:stage = dev
effortless:handler = orders
effortless:type = lambda
```

**Benefits:**
- AWS is always the source of truth
- No sync issues - query AWS, get current state
- Works in teams without locking
- State survives across machines, CI environments
- Resource Groups Tagging API: one call to find all resources

**Trade-off:** Resource Groups Tagging API has indexing delay (~1-2 minutes). For new resources, Effortless uses direct API responses. Tags are for discovery of existing resources.

---

## Why Not Terraform/Pulumi?

Excellent tools, but:

1. **Separate language/DSL** - HCL, YAML, or their SDK
2. **State management overhead** - backends, locking, imports
3. **General purpose** - designed for any cloud, any resource
4. **Learning curve** - significant investment to master

Effortless is:
1. **TypeScript only** - one language for infra and code
2. **Stateless** - tags + API queries
3. **Focused** - Lambda ecosystem only, but done well
4. **Zero config** - export a function, get infrastructure

---

## Why Not SST?

SST v3 moved from CloudFormation to Pulumi/Terraform — faster deploys and multi-cloud support. It has a solid Console (logs, errors, team management). It's the closest mainstream competitor.

**But SST is still infrastructure AS code**, not FROM code:

```typescript
// SST — you define infrastructure explicitly in sst.config.ts
const table = new sst.aws.Dynamo("Orders", {
  fields: { id: "string" },
  primaryIndex: { hashKey: "id" },
});

// then link it to your function
new sst.aws.Function("Api", {
  handler: "src/api.handler",
  link: [table],
});

// then in your handler, you use the SDK manually
import { Resource } from "sst";
const tableName = Resource.Orders.name;
// ...raw DynamoDB SDK calls, no typed client
```

```typescript
// Effortless — infrastructure IS the code
export const orders = defineTable({
  schema: unsafeAs<{ id: string; amount: number }>(),
  primaryKey: "id",
  onInsert: async ({ newItem }) => {
    // typed: newItem.amount is number
  },
});

// In another handler — typed client, auto IAM, no config
await orders.put({ id: "abc", amount: 99 });
```

Key differences:

| | SST v3 | Effortless |
|---|---|---|
| Infrastructure definition | Separate config file (`sst.config.ts`) | Export handlers from app code |
| Typed client from schema | No — raw SDK, manual types | Yes — `defineTable` → typed `.put()`, `.get()` |
| State management | Pulumi state (S3 + lock) | No state files — AWS tags |
| Deployment engine | Pulumi/Terraform | Direct AWS SDK calls |
| Dashboard | Yes (SST Console) | Planned (control plane + web UI) |
| Live dev (local proxy) | Yes (`sst dev`) | No — fast redeploys (~5s) |
| Deploy speed | ~30s (Pulumi diff) | ~5-10s (direct API calls) |

SST's `sst dev` proxies Lambda invocations to your local machine, so you can set breakpoints and hot-reload without redeploying. Effortless takes a different stance: local mocks (in-memory DynamoDB, fake IAM) create false confidence — "works locally, breaks on AWS" is a real problem. Instead, Effortless relies on fast direct deploys (~5s) and encourages writing tests for correctness. If you're unsure something works, a test catches it reliably; manual localhost poking does not.

SST is great for teams already comfortable with IaC who want better DX. Effortless is for teams who don't want to write infrastructure code at all.

---

## Why Not Nitric?

Nitric is the closest to effortless philosophically — true infrastructure-from-code where you write app code and infrastructure is inferred.

**But Nitric trades depth for breadth:**

```typescript
// Nitric — multi-cloud, but generic API
import { api, collection } from "@nitric/sdk";

const orders = collection("orders").for("writing");

api("main").post("/orders", async (ctx) => {
  await orders.doc("abc").set({ amount: 99 });
  // no schema validation, no typed fields
  // works on AWS, GCP, Azure — but lowest common denominator
});
```

```typescript
// Effortless — AWS-native, schema-driven
export const orders = defineTable({
  schema: unsafeAs<{ id: string; amount: number }>(),
  primaryKey: "id",
});
// orders.put() is typed, validated, auto-IAM'd
```

| | Nitric | Effortless |
|---|---|---|
| Multi-cloud | Yes (AWS, GCP, Azure) | No — AWS only |
| Typed clients from schema | No | Yes |
| Schema validation at runtime | No | Yes |
| Deployment engine | Pulumi/Terraform | Direct AWS SDK |
| Own runtime/SDK | Yes (gRPC sidecar) | No — native AWS Lambda |
| State files | Yes (Terraform/Pulumi state) | No — AWS tags |
| AWS-specific features | Limited (lowest common denominator) | Full (DynamoDB streams, API Gateway features, etc.) |

Nitric is better if you need multi-cloud. Effortless is better if you're on AWS and want deep integration, type safety, and zero abstraction overhead.

---

## Why Not Ampt?

Ampt (spun off from Serverless Cloud) does infrastructure-from-code with sub-second sandbox deploys.

**But Ampt is a managed platform — you're locked into their service:**

| | Ampt | Effortless |
|---|---|---|
| Runs in your AWS account | No — Ampt-managed | Yes — your account, your control |
| Vendor dependency | Ampt service must exist | None — direct AWS SDK |
| Open source | No | Yes |
| Pricing | Per-invocation (Ampt pricing) | AWS costs only |
| Portability | Locked to Ampt | Standard AWS Lambda |

If Ampt shuts down, your app needs rewriting. Effortless deploys standard AWS resources — your app runs with or without effortless.

---

## Why Not Alchemy?

[Alchemy](https://alchemy.run/) is a TypeScript-native IaC library that provisions cloud resources (Cloudflare, AWS, GitHub) via direct HTTPS calls. No YAML, no CloudFormation — just TypeScript.

**But Alchemy is infrastructure-AS-code, not FROM-code:**

```typescript
// Alchemy — you explicitly declare resources
const db = await Database("my-db");
const bucket = await Bucket("assets", {
  bucketName: `my-bucket-${stage}`
});
const worker = await Worker("api", {
  bindings: { DB: db }
});
// You still manage resources manually — Alchemy just makes the language nicer
```

```typescript
// Effortless — infrastructure IS the code
export const orders = defineTable({
  schema: unsafeAs<{ id: string; amount: number }>(),
  primaryKey: "id",
});

export const api = defineApi({
  basePath: "/orders",
  deps: () => ({ orders }),  // ← auto IAM, typed client
  get: {
    "/": async ({ deps }) => {
      const items = await deps.orders.query(/* fully typed */);
      return { status: 200, body: items };
    },
  },
});
// No resource declarations — Lambda, IAM, Function URL all inferred
```

| | Alchemy | Effortless |
|---|---|---|
| Approach | Infrastructure-as-code (TS instead of YAML) | Infrastructure-from-code (inferred from handlers) |
| Abstraction level | Medium — explicit resource declarations | High — `define*` → everything |
| Typed runtime clients | No — provisioning only | Yes — `TableClient<T>`, auto IAM |
| State management | Local state files (like Terraform) | No state files — AWS tags |
| Multi-cloud | Yes (Cloudflare, AWS, GitHub) | No — AWS only |
| Runtime wrappers | No — you write Lambda handlers yourself | Yes — wrappers, DI, context caching |
| Deployment engine | Direct HTTPS to cloud APIs | Direct AWS SDK calls |
| AI-first | Yes — generate resources via LLMs | No — but resources are inferred, so nothing to generate |

Alchemy competes with Pulumi and CDK — it makes IaC nicer by replacing YAML with TypeScript. Effortless eliminates IaC entirely: you write handlers, infrastructure follows.

Alchemy is a good fit if you need multi-cloud provisioning in TypeScript. Effortless is for teams on AWS who don't want to write infrastructure code at all.

---

## Why Not Serverless Framework?

Serverless Framework v3+ builds on CloudFormation:

```
Serverless Framework → CloudFormation → AWS
```

It inherits CloudFormation's slow deployments, stack limits (500 resources), complex error messages, and rollback behavior. You also write YAML config (`serverless.yml`) separately from your code.

Effortless bypasses all of this with direct SDK calls and zero config files.

---

## Comparison Summary

| Aspect | SST v3 | Nitric | Alchemy | Ampt | Effortless |
|--------|--------|--------|---------|------|------------|
| Infra from code (not config) | No | Yes | No | Yes | **Yes** |
| Typed client from `define*` | No | No | No | No | **Yes** |
| Schema → validation + types | No | No | No | No | **Yes** |
| Auto IAM wiring | Yes (linking) | Yes | No | Yes | **Yes** |
| No state files | No | No | No | N/A | **Yes** |
| Runs in your AWS account | Yes | Yes | Yes | No | **Yes** |
| Dashboard / Console | Yes | Yes | No | Yes | Planned |
| Multi-cloud | Partial | Yes | Yes | No | No |
| Deploy speed | ~30s | ~30s | Fast | <1s | ~5-10s |
| Open source | Yes | Yes | Yes | No | **Yes** |

**What only effortless does**: one `define*` call creates the AWS resource, generates a typed runtime client, wires IAM permissions, and validates data with the schema — all from a single TypeScript export. No config files, no state files, no separate infrastructure definitions.

**Philosophy:** Direct is better than indirect. Fast is better than safe-but-slow. Simple is better than complete.
