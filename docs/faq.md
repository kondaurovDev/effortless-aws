# FAQ

## Why AWS?

We chose AWS Lambda over alternatives (Vercel, GCP Cloud Functions, Cloudflare Workers) for several reasons:

### 1. Complete Infrastructure SDK

AWS provides SDK access to **all** resources, not just compute:

```typescript
// Create any resource programmatically
const sqs = new SQSClient({});
const dynamodb = new DynamoDBClient({});
const eventbridge = new EventBridgeClient({});

// Full control over: queues, tables, schedules, API gateways, IAM, S3...
```

**Vercel/Cloudflare**: Functions only. Need external services for queues, databases, scheduling.

**GCP**: SDK exists but ecosystem is fragmented (Cloud Run, Cloud Functions, App Engine).

**AWS**: One SDK, one account, all resources. Build complete backends without third-party services.

### 2. Fast Deployment (No Container Builds)

| Provider | Deployment Model | Deploy Time |
|----------|------------------|-------------|
| AWS Lambda | ZIP upload | 3-5 seconds |
| GCP Cloud Functions (2nd gen) | Container build | 1-3 minutes |
| Vercel Functions | ZIP upload | 5-15 seconds |
| Cloudflare Workers | JS bundle | 1-3 seconds |

GCP Cloud Functions 2nd gen uses Cloud Run under the hood, which requires building a Docker image via Buildpacks. Every deploy triggers a full container build.

AWS Lambda uses Firecracker microVMs with pre-built runtimes. We upload ZIP, Lambda runs immediately.

### 3. Cost (Almost Free)

**AWS Lambda Free Tier (permanent, not just trial):**
- 1M requests/month free
- 400,000 GB-seconds/month free
- ~$0.20 per additional 1M requests

**For a typical side project:**
- DynamoDB: 25GB storage + 25 WCU/RCU free
- API Gateway: 1M requests free (first 12 months)
- SQS: 1M requests/month free
- EventBridge: First 14M events free

**Real cost for small-medium apps: $0-5/month**

**Vercel**: Free tier limited (100GB bandwidth, 100K function invocations). Pro starts at $20/month.

**GCP**: Similar free tier but Cloud Functions 2nd gen has minimum instance charges.

### 4. Mature Ecosystem

- 17+ years of production use
- Battle-tested at massive scale
- Extensive documentation
- Large community and talent pool
- Predictable behavior (no breaking changes)

### Trade-offs

**Cloudflare Workers** is faster for edge compute (0ms cold start) but limited to JS/WASM and has no integrated backend services.

**Vercel** is better for frontend-focused projects with simpler deployment, but you'll need external services for anything beyond functions.

**GCP** is competitive but the 2nd gen Cloud Functions container build time kills developer velocity.

**Our choice**: AWS gives us the complete toolkit to build entire backends from TypeScript exports, with the fastest iteration cycle and lowest cost.

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

### Our Approach: Direct AWS SDK Calls

```
Your Code → AWS SDK → AWS API
```

**No intermediary.** We call the same APIs that CloudFormation calls, but directly.

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

We're fast because:
1. We make direct API calls
2. We parallelize independent operations
3. We use `ensure*` pattern - check existence, create or update

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

Our imperative approach is:
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

**Our approach:** AWS tags ARE the state.

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

**Trade-off:** Resource Groups Tagging API has indexing delay (~1-2 minutes). For new resources, we use direct API responses. Tags are for discovery of existing resources.

---

## Why Not Terraform/Pulumi?

They're excellent tools, but:

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
  schema: { id: Schema.String, amount: Schema.Number },
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
| Deploy speed | ~30s (Pulumi diff) | ~5-10s (direct API calls) |

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
  schema: { id: Schema.String, amount: Schema.Number },
  primaryKey: "id",
});
// orders.put() is typed, validated, auto-IAM'd
```

| | Nitric | Effortless |
|---|---|---|
| Multi-cloud | Yes (AWS, GCP, Azure) | No — AWS only |
| Typed clients from schema | No | Yes |
| Schema validation at runtime | No | Yes (Effect Schema) |
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

## Why Not Serverless Framework?

Serverless Framework v3+ builds on CloudFormation:

```
Serverless Framework → CloudFormation → AWS
```

It inherits CloudFormation's slow deployments, stack limits (500 resources), complex error messages, and rollback behavior. You also write YAML config (`serverless.yml`) separately from your code.

Effortless bypasses all of this with direct SDK calls and zero config files.

---

## Comparison Summary

| Aspect | SST v3 | Nitric | Ampt | Effortless |
|--------|--------|--------|------|------------|
| Infra from code (not config) | No | Yes | Yes | **Yes** |
| Typed client from `define*` | No | No | No | **Yes** |
| Schema → validation + types | No | No | No | **Yes** |
| Auto IAM wiring | Yes (linking) | Yes | Yes | **Yes** |
| No state files | No | No | N/A | **Yes** |
| Runs in your AWS account | Yes | Yes | No | **Yes** |
| Dashboard / Console | Yes | Yes | Yes | Planned |
| Multi-cloud | Partial | Yes | No | No |
| Deploy speed | ~30s | ~30s | <1s | ~5-10s |
| Open source | Yes | Yes | No | **Yes** |

**What only effortless does**: one `define*` call creates the AWS resource, generates a typed runtime client, wires IAM permissions, and validates data with the schema — all from a single TypeScript export. No config files, no state files, no separate infrastructure definitions.

**Philosophy:** Direct is better than indirect. Fast is better than safe-but-slow. Simple is better than complete.
