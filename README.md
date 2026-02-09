# effortless-aws

Code-first AWS Lambda framework. Export handlers, deploy to AWS. No infrastructure files needed.

```bash
npm install effortless-aws
```

## What it looks like

```typescript
// src/api.ts
import { defineHttp, defineTable, param } from "effortless-aws";

// DynamoDB table — just export it, get the table
export const orders = defineTable<Order>({
  pk: { name: "id", type: "string" },
  onRecord: async ({ record, table }) => {
    if (record.eventName === "INSERT") {
      await table.put({ ...record.new!, status: "confirmed" });
    }
  },
});

// HTTP endpoint — creates API Gateway + Lambda + route
export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  schema: (input) => parseOrder(input),
  deps: { orders },
  params: { apiKey: param("stripe-key") },
  context: async ({ params }) => ({
    stripe: new Stripe(params.apiKey),
  }),
  onRequest: async ({ data, ctx, deps }) => {
    await deps.orders.put({ id: crypto.randomUUID(), ...data });
    return { status: 201, body: { ok: true } };
  },
});
```

```bash
npx eff deploy
```

That's it. No YAML, no CloudFormation, no state files.

## Why

Traditional Lambda development splits infrastructure and code across multiple files and languages. Adding a single endpoint means touching CloudFormation/CDK/Terraform templates, IAM policies, and handler code separately.

**Effortless** derives infrastructure from your TypeScript exports. One `defineHttp` call creates the API Gateway route, Lambda function, and IAM role. One `defineTable` call creates the DynamoDB table, stream, event source mapping, and processor Lambda.

## Killer features

**Infrastructure from code** — export a handler, get the AWS resources. No config files, no YAML.

**Typed everything** — `defineTable` schema gives you typed `table.put()`, typed `deps.orders.get()`, typed `record.new`. One definition, types flow everywhere.

**Direct AWS SDK deploys** — no CloudFormation, no Pulumi. Direct API calls. Deploy in ~5-10s, not 5-10 minutes.

**No state files** — AWS resource tags are the source of truth. No tfstate, no S3 backends, no drift.

**Cross-handler deps** — `deps: { orders }` auto-wires IAM permissions and injects a typed `TableClient`. Zero config.

**SSM params** — `param("stripe-key")` fetches from Parameter Store at cold start. Auto IAM, auto caching, supports transforms.

**Partial batch failures** — DynamoDB stream processing reports failed records individually. No batch-level retries for one bad record.

**Cold start caching** — `context` factory runs once per cold start, cached across invocations. Put DB connections, SDK clients, config there.

## Handler types

### HTTP

```typescript
export const getUser = defineHttp({
  method: "GET",
  path: "/users/{id}",
  onRequest: async ({ req }) => {
    return { status: 200, body: { id: req.params.id } };
  },
});
```

### DynamoDB Table + Stream

```typescript
export const users = defineTable({
  pk: { name: "id", type: "string" },
  sk: { name: "email", type: "string" },
  ttlAttribute: "expiresAt",
  onRecord: async ({ record, table }) => {
    console.log(record.eventName, record.new);
  },
});
```

### Table (resource only, no stream)

```typescript
export const sessions = defineTable({
  pk: { name: "id", type: "string" },
  ttlAttribute: "expiresAt",
});
```

## Configuration

```typescript
// effortless.config.ts
import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "my-app",
  region: "eu-central-1",
  handlers: ["src/**/*.ts"],
});
```

## CLI

```bash
npx eff deploy              # deploy all handlers
npx eff deploy --stage prod # deploy to specific stage
npx eff deploy --only users # deploy single handler
npx eff destroy             # remove all resources
npx eff logs users --follow # stream CloudWatch logs
npx eff list                # show deployed resources
```

## How it works

1. **Static analysis** (ts-morph) — reads your exports, extracts handler config from AST
2. **Bundle** (esbuild) — wraps each handler with a runtime adapter
3. **Deploy** (AWS SDK) — creates/updates Lambda, API Gateway, DynamoDB, IAM directly

No CloudFormation stacks. No Terraform state. Tags on AWS resources are the only state.

## Compared to

| | SST v3 | Nitric | Serverless | **Effortless** |
|---|---|---|---|---|
| Infra from code (not config) | No | Yes | No | **Yes** |
| Typed client from schema | No | No | No | **Yes** |
| No state files | No | No | No | **Yes** |
| Deploy speed | ~30s | ~30s | minutes | **~5-10s** |
| Runs in your AWS account | Yes | Yes | Yes | **Yes** |
| Open source | Yes | Yes | Yes | **Yes** |

## License

MIT
