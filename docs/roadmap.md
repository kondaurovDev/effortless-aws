# Roadmap

Planned features for effortless. Some ideas are inspired by serverless community patterns and projects like [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/).

Since effortless controls both the runtime and the deployment, these features can be integrated deeper than in a standalone library — auto-creating infrastructure, wiring IAM permissions, and reducing boilerplate.

See also: [CLI Roadmap](./roadmap-cli.md)

## Features

- [Idempotency](#idempotency)
- [Parameters & Secrets](#parameters--secrets)
- [Structured Logger](#structured-logger)
- [Metrics (CloudWatch EMF)](#metrics-cloudwatch-emf)
- [Tracer (X-Ray)](#tracer-x-ray)
- [Middleware Pipeline](#middleware-pipeline)
- [Typed Inter-Handler Communication](#typed-inter-handler-communication)
- [DLQ & Failure Handling](#dlq--failure-handling)
- [defineFunction & Durable Mode](#definefunction--durable-mode)
- [Control Plane & Web Dashboard](#control-plane--web-dashboard)

---

## Idempotency

**Problem**: Lambda can be invoked multiple times for the same event (SQS retry, API Gateway timeout, stream replay). Without protection this means duplicate payments, duplicate emails, duplicate records.

**Approach**: Declare `idempotency` in the handler — effortless creates the DynamoDB table on deploy and wires IAM permissions automatically.

```typescript
export const createPayment = defineHttp({
  method: "POST",
  path: "/payments",
  idempotency: {
    key: (req) => req.body.paymentId,
    ttl: "1 hour",
  },
  onRequest: async ({ req }) => {
    await chargeCustomer(req.body);
    return { status: 200, body: { ok: true } };
  },
});

export const processOrders = defineQueue({
  messageSchema: OrderSchema,
  idempotency: {
    key: (msg) => msg.orderId,
    ttl: "24 hours",
  },
  handler: async (messages) => {
    // each message is deduplicated by orderId
  },
});
```

**What effortless auto-creates on deploy**:
- DynamoDB table `{project}-{stage}-idempotency` (PAY_PER_REQUEST, TTL enabled)
- IAM permissions for the Lambda to read/write to it
- TTL attribute for automatic cleanup

**Status**: Planned

---

## Parameters & Secrets

**Problem**: Lambdas need config values (DB URLs, API keys, feature flags) from SSM Parameter Store, Secrets Manager, or AppConfig. Without caching, every invocation makes an API call — slow and expensive.

**Approach**: Declare parameters in the handler definition. Effortless fetches and caches them at runtime, and auto-adds IAM permissions on deploy.

```typescript
export const api = defineHttp({
  method: "GET",
  path: "/orders",
  params: {
    dbUrl: param("/prod/database-url"),
    stripeKey: secret("prod/stripe-api-key"),
    features: appConfig("my-app", "feature-flags"),
  },
  onRequest: async ({ req, params }) => {
    // params.dbUrl    — string, cached, from SSM Parameter Store
    // params.stripeKey — string, cached, from Secrets Manager
    // params.features  — object, cached, from AppConfig
  },
});
```

**What effortless auto-adds on deploy**:
- `ssm:GetParameter` permission for each param path
- `secretsmanager:GetSecretValue` permission for each secret ARN
- `appconfig:GetConfiguration` permission for each app/profile
- Cache with configurable TTL (default 5 minutes)

**Status**: Planned

---

## Structured Logger

**Problem**: `console.log` produces unstructured output. In CloudWatch you can't search by request ID, can't filter by cold start, can't correlate logs across services.

**Approach**: Built into every handler via the Effect logging system. Automatically enriches logs with Lambda context. Zero config for basic use, customizable for advanced.

```typescript
export const api = defineHttp({
  method: "POST",
  path: "/orders",
  log: {
    level: "info",
    sampleRate: 0.1,  // 10% of requests also log DEBUG
  },
  onRequest: async ({ req, log }) => {
    log.info("Processing order", { orderId: req.body.id });
    // output: {"level":"INFO","message":"Processing order","orderId":"abc-123",
    //          "requestId":"xxx","functionName":"createOrder","coldStart":false,
    //          "timestamp":"2025-01-15T10:30:00Z"}

    log.debug("Full payload", { body: req.body });
    // only logged for 10% of requests (when sampleRate triggers)
  },
});
```

**Automatic enrichment (no config needed)**:
- `requestId` — from Lambda context
- `functionName` — from Lambda context
- `coldStart` — detected automatically
- `timestamp` — ISO 8601
- `xrayTraceId` — from environment
- `level` — INFO, DEBUG, WARN, ERROR

**Status**: Planned

---

## Metrics (CloudWatch EMF)

**Problem**: Custom business metrics (orders processed, payment amounts, error rates) require either `putMetricData` API calls (expensive, slow) or manually formatting CloudWatch Embedded Metric Format.

**Approach**: Inject `metrics` into every handler. Metrics are collected during invocation and flushed as EMF JSON to stdout on completion — CloudWatch parses the format automatically, no API calls needed.

```typescript
export const api = defineHttp({
  method: "POST",
  path: "/orders",
  metrics: {
    namespace: "MyApp",  // or default to project name
  },
  onRequest: async ({ req, metrics }) => {
    const order = await createOrder(req.body);

    metrics.add("OrderCreated", 1);
    metrics.add("OrderAmount", order.amount, "Count");
    metrics.add("ProcessingTime", elapsed, "Milliseconds");

    // dimensions added automatically: handler, stage
    // flushed as EMF to stdout when handler returns
  },
});
```

**Status**: Planned

---

## Tracer (X-Ray)

**Problem**: Without distributed tracing, you can't see where time is spent: cold start, DynamoDB call, external API, business logic. Debugging latency in production is guesswork.

**Approach**: Enable with a flag — effortless configures `TracingConfig: Active` on the Lambda at deploy time and wraps the handler automatically.

```typescript
export const api = defineHttp({
  method: "GET",
  path: "/users/{id}",
  tracing: true,
  onRequest: async ({ req, tracer }) => {
    // handler automatically traced as a segment

    const user = await tracer.trace("fetchUser", () =>
      db.get({ id: req.params.id })
    );

    const enriched = await tracer.trace("enrichProfile", () =>
      enrichWithExternalData(user)
    );

    return { status: 200, body: enriched };
  },
});
```

**What effortless auto-configures on deploy**:
- `TracingConfig: { Mode: "Active" }` on the Lambda function
- IAM permissions for `xray:PutTraceSegments`, `xray:PutTelemetryRecords`
- AWS SDK auto-instrumentation

**Status**: Planned

---

## Middleware Pipeline

**Problem**: Cross-cutting concerns (CORS, auth, rate limiting, request validation, response compression) are duplicated across handlers.

**Approach**: First-class middleware support in handler definitions. Middleware can also trigger infrastructure changes (e.g., auth middleware adds Cognito/JWT authorizer on API Gateway).

```typescript
export const api = defineHttp({
  method: "POST",
  path: "/orders",
  middleware: [
    cors({ origins: ["https://myapp.com"] }),
    compress(),  // gzip responses > 1KB
    rateLimit({ max: 100, window: "1 minute" }),  // uses DynamoDB counter
  ],
  onRequest: async ({ req }) => {
    return { status: 200, body: { ok: true } };
  },
});
```

**Status**: Planned (design phase — needs pipeline architecture)

---

## Typed Inter-Handler Communication

**Problem**: Handlers need to interact with resources defined by other handlers — send to a queue, read from a table, put to a bucket. This requires manual AWS SDK calls, hardcoded resource URLs/ARNs, and separately configured IAM permissions.

**Approach**: `define*` returns an object that serves as both a deployment descriptor and a typed runtime client. Use it directly — effortless detects the dependency at build time and wires everything.

```typescript
export const processOrder = defineQueue({
  messageSchema: Schema.Struct({
    orderId: Schema.String,
    amount: Schema.Number,
  }),
  handler: async (messages) => {
    for (const msg of messages) {
      await fulfillOrder(msg.orderId, msg.amount);
    }
  },
});

export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  onRequest: async ({ req }) => {
    // type-safe — payload shape inferred from processOrder's messageSchema
    await processOrder.send({ orderId: "abc-123", amount: 99 });
    return { status: 202, body: { queued: true } };
  },
});
```

The same pattern applies to all resource types:
- `queue.send(payload)` — SQS
- `table.put(item)`, `table.get(key)` — DynamoDB
- `topic.publish(payload)` — SNS
- `bucket.put(key, data)`, `bucket.getSignedUrl(key)` — S3

**What effortless auto-wires on deploy**:
- IAM permissions (e.g. `sqs:SendMessage` from `createOrder` to `processOrder` queue)
- Resource URLs/ARNs injected via environment variables

**Status**: Planned

---

## DLQ & Failure Handling

**Problem**: When queue messages fail processing, they either retry infinitely or disappear. Setting up a Dead Letter Queue manually requires creating a second SQS queue, configuring redrive policy, and wiring a separate Lambda to process failures.

**Approach**: `defineQueue` supports batch processing (like DynamoDB streams) and declarative DLQ configuration. Use `onMessage` for per-message processing or `onBatch` for the entire batch — they are mutually exclusive.

Per-message processing:

```typescript
export const processOrder = defineQueue({
  messageSchema: OrderSchema,
  batchSize: 10,
  batchWindow: "30 seconds",
  dlq: { maxRetries: 3 },
  onMessage: async ({ message }) => {
    await fulfillOrder(message);
  },
  onFailed: async ({ failures }) => {
    await alertOpsTeam(failures);
  },
});
```

Batch processing:

```typescript
export const importProducts = defineQueue({
  messageSchema: ProductSchema,
  batchSize: 100,
  batchWindow: "60 seconds",
  dlq: { maxRetries: 3 },
  onBatch: async ({ messages }) => {
    await db.bulkInsert(messages);
  },
});
```

**What effortless auto-creates on deploy**:
- SQS DLQ `{project}-{stage}-{handler}-dlq`
- Redrive policy on the main queue (`maxReceiveCount` from `maxRetries`)
- Event source mapping with `batchSize` and `MaximumBatchingWindowInSeconds`
- Lambda + event source mapping for `onFailed` (if provided)
- IAM permissions for all of the above

**Status**: Planned

---

## defineFunction & Durable Mode

**Problem**: Not every Lambda needs a trigger. Background jobs, workflows, and shared logic need to be callable from other handlers. Complex multi-step workflows need checkpoint/replay to avoid repeated side effects on failure.

**Approach**: `defineFunction` is a Lambda without a trigger — other handlers call it via inter-handler communication (`.invoke()` / `.start()`). The `durable` option accepts a function that derives the execution name from input, enabling [AWS Durable Functions](https://aws.amazon.com/blogs/compute/introducing-durable-functions-for-aws-lambda/) with `step()` checkpoints and `wait()` for external signals.

```typescript
export const processOrder = defineFunction({
  timeout: "7 days",
  durable: (input) => `order-${input.orderId}`,
  onInvoke: async ({ input, step, wait }) => {
    const order = await step("validate", () => validateOrder(input.orderId));
    const payment = await step("charge", () => chargeCustomer(order));

    const approval = await wait.callback("warehouse-approval", {
      timeout: "24 hours",
    });

    if (!approval.approved) {
      await step("refund", () => refundPayment(payment.id));
      return { status: "cancelled" };
    }

    await step("ship", () => shipOrder(order.id));
    return { status: "completed" };
  },
});

export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  onRequest: async ({ req }) => {
    const execId = await processOrder.start({ orderId: req.body.id });
    return { status: 202, body: { executionId: execId } };
  },
});
```

Two invocation modes:
- `fn.invoke(payload)` — synchronous, waits for result
- `fn.start(payload)` — asynchronous, returns `executionId`

**Idempotency**: The `durable` function derives execution name from input — calling with the same name returns the existing result, no DynamoDB table needed. Two levels don't mix: DynamoDB for regular handlers, execution name for durable.

**What effortless auto-configures on deploy**:
- Lambda with `DurableConfig` enabled (when `durable` is set)
- `ExecutionTimeout` from config
- IAM permissions for durable execution APIs and cross-handler invocation

**Status**: Planned

---

## Control Plane & Web Dashboard

**Problem**: Currently effortless deploys from the developer's machine using local AWS credentials. This means every developer needs long-lived IAM access keys configured locally — complex onboarding, security risk (keys don't expire), and no shared visibility into what's deployed.

**Approach**: Deploy a **control plane Lambda** into the user's AWS account that has permissions to create and manage effortless resources. The CLI and a web dashboard communicate with this Lambda instead of directly with AWS.

### Phase 1: Control Plane Lambda

A management Lambda with an IAM role scoped to effortless operations (create/update/delete Lambda, DynamoDB, API Gateway, SQS, etc.).

```
CLI
  ↓ (HTTPS)
API Gateway + auth
  ↓
Control Plane Lambda (scoped IAM role)
  ├── deploy:  receive bundle via S3 presigned URL → create/update resources
  ├── status:  read tags → return resource state
  ├── logs:    query CloudWatch Logs → stream back
  └── cleanup: delete resources by tags
```

**Bootstrap**: One-time setup via CloudFormation one-click template or `effortless init` command. After that, developers only need an API key or short-lived token — no AWS credentials.

**Key considerations**:
- Upload bundles via S3 presigned URL (Lambda 6MB sync payload limit)
- Long deploys run async: CLI submits job → polls for status
- Auth options: API key (simple), Cognito (teams), IAM Identity Center (enterprise)

### Phase 2: Web Dashboard

Minimal web app backed by the same control plane API:

- **Resources** — list all deployed functions, tables, queues with status
- **Logs** — real-time log viewer with filtering by handler, level, request ID
- **Deploy** — trigger deploys, see deploy history and diffs
- **Metrics** — invocation count, error rate, duration (from CloudWatch/EMF)

### Phase 3: Observability & Collaboration

- **Monitoring dashboards** — auto-generated per-handler metrics, alerting
- **Preview environments** — deploy from PR via GitHub integration
- **Team management** — multiple developers, role-based access
- **Trace viewer** — X-Ray traces visualized in the dashboard

**What makes this powerful**: effortless controls the entire stack (build → deploy → runtime → observability). Unlike generic dashboards, this knows the semantics — it can show a `defineTable` with its stream handler, DLQ, and connected functions as one logical unit.

**Status**: Planned

---

## Priority & Implementation Order

| # | Feature | Complexity | Value | Effortless advantage |
|---|---------|-----------|-------|---------------------|
| 1 | **Inter-Handler Communication** | High | Very high | Type-safe clients, auto IAM, no hardcoded URLs |
| 2 | **DLQ & Failure Handling** | Medium | Very high | Auto-creates DLQ + redrive policy + failure handler |
| 3 | **defineFunction & Durable** | High | Very high | Triggerless Lambda + checkpoint/replay workflows |
| 4 | **Idempotency** | Medium | Very high | Auto-creates DynamoDB table + IAM on deploy |
| 5 | **Parameters & Secrets** | Low | High | Auto-adds IAM permissions on deploy |
| 6 | **Structured Logger** | Low | High | Extends existing Effect Logger with Lambda context |
| 7 | **Metrics (EMF)** | Low | Medium | Auto-flush, zero API calls |
| 8 | **Tracer (X-Ray)** | Medium | Medium | Auto-enables tracing config on deploy |
| 9 | **Middleware** | High | Medium | Infrastructure-aware middleware (auth, rate limit) |
| 10 | **Control Plane** | High | Very high | No local AWS keys, one-click setup, shared visibility |
| 11 | **Web Dashboard** | High | High | Observability + deploy UI backed by control plane API |

---

## Design Principles for New Features

1. **Zero config for common cases** — sane defaults, opt-in customization
2. **Infrastructure follows code** — if a feature needs a DynamoDB table or IAM permission, effortless creates it on deploy
3. **Type-safe API** — every parameter, every callback, every return value is typed
4. **Effect inside, simple outside** — use Effect for internal reliability, but expose async/await to users
5. **No runtime dependencies** — features like EMF metrics and structured logging work via stdout, not API calls
