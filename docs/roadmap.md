# Roadmap

Planned features for effortless. Some ideas are inspired by serverless community patterns and projects like [AWS Lambda Powertools](https://docs.powertools.aws.dev/lambda/typescript/latest/).

Since effortless controls both the runtime and the deployment, these features can be integrated deeper than in a standalone library — auto-creating infrastructure, wiring IAM permissions, and reducing boilerplate.

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

## Priority & Implementation Order

| # | Feature | Complexity | Value | Effortless advantage |
|---|---------|-----------|-------|---------------------|
| 1 | **Idempotency** | Medium | Very high | Auto-creates DynamoDB table + IAM on deploy |
| 2 | **Parameters & Secrets** | Low | High | Auto-adds IAM permissions on deploy |
| 3 | **Structured Logger** | Low | High | Extends existing Effect Logger with Lambda context |
| 4 | **Metrics (EMF)** | Low | Medium | Auto-flush, zero API calls |
| 5 | **Tracer (X-Ray)** | Medium | Medium | Auto-enables tracing config on deploy |
| 6 | **Middleware** | High | Medium | Infrastructure-aware middleware (auth, rate limit) |

---

## Design Principles for New Features

1. **Zero config for common cases** — sane defaults, opt-in customization
2. **Infrastructure follows code** — if a feature needs a DynamoDB table or IAM permission, effortless creates it on deploy
3. **Type-safe API** — every parameter, every callback, every return value is typed
4. **Effect inside, simple outside** — use Effect for internal reliability, but expose async/await to users
5. **No runtime dependencies** — features like EMF metrics and structured logging work via stdout, not API calls
