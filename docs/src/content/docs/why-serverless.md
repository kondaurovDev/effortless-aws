---
title: Why Serverless?
description: Serverless vs containers, VMs, and traditional hosting — when Lambda makes sense and when it doesn't.
---

You have a backend to run. The options: a VM, a container, or a serverless function. Each trades off control for convenience. This page explains when serverless is the right choice — and when it isn't.

## What "serverless" actually means

Serverless doesn't mean "no servers." It means you don't manage them. You write a function, upload it, and the cloud provider handles everything else: provisioning, scaling, patching, monitoring, availability.

With Lambda specifically:
- You write a function that takes an event and returns a response
- AWS runs it in an isolated environment
- You pay only when the function executes
- It scales from zero to thousands of concurrent executions automatically

## Serverless vs containers vs VMs

| | VM (EC2) | Container (ECS/Fargate) | Serverless (Lambda) |
|---|---|---|---|
| You manage | OS, runtime, app, scaling, networking | Container image, scaling rules, networking | Application code only |
| Scaling | Manual or auto-scaling groups | Task count rules | Automatic, per-request |
| Minimum cost | ~$15/month (t3.micro, always running) | ~$10/month (Fargate, always running) | $0 (pay per invocation) |
| Cold start | None (always running) | 10-30s (new task) | 100-200ms (Node.js) |
| Max execution time | Unlimited | Unlimited | 15 minutes |
| Deployment | SSH, AMIs, user data scripts | Docker build + push + rolling update | ZIP upload, 3-5 seconds |

### What you stop managing

With a container, you still handle:
- **Dockerfiles** — base images, multi-stage builds, layer caching
- **Container registry** — pushing images, cleaning old tags, vulnerability scanning
- **Orchestration** — ECS task definitions, service configs, desired count
- **Networking** — VPC, subnets, security groups, load balancers, target groups
- **Scaling rules** — CPU thresholds, step scaling, cooldown periods
- **Health checks** — readiness probes, liveness probes, grace periods
- **Deploys** — rolling updates, blue-green, circuit breakers, rollback triggers

With Lambda, all of that is replaced by: upload your code. AWS handles the rest.

### What you gain

**Zero idle cost.** A container or VM runs 24/7 whether it serves traffic or not. Lambda charges per request — 1M requests/month is free, then $0.20 per million. A side project with 100 requests/day costs effectively nothing.

**Automatic scaling.** No scaling rules to configure. Lambda handles 1 request/minute and 1,000 requests/second with the same code and zero configuration. You don't think about capacity.

**No patching.** AWS updates the Node.js runtime, the operating system, and the security patches. You never SSH into anything. There's no "patch Tuesday."

**Isolation.** Each Lambda invocation runs in its own environment. One slow request doesn't block another. One crash doesn't take down the service.

**Faster iteration.** Deploy in seconds, not minutes. No Docker builds, no image pushes, no rolling updates. Change code, `npx eff deploy`, done.

## When serverless works best

### APIs and webhooks

Short-lived request-response workloads are the sweet spot. An HTTP request comes in, you process it, return a response. Lambda is designed exactly for this.

```typescript
export const createOrder = defineHttp({
  method: "POST",
  path: "/orders",
  deps: { orders },
  onRequest: async ({ req, deps }) => {
    await deps.orders.put({ id: crypto.randomUUID(), ...req.body });
    return { status: 201, body: { ok: true } };
  },
});
```

### Event-driven processing

A row is inserted into a database. A message arrives in a queue. A file is uploaded to S3. Lambda reacts to events without polling, without a running process, without cron jobs.

```typescript
export const orders = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Order>(),
  onRecord: async ({ record }) => {
    // Runs automatically on every insert/update/delete
    await notifyWarehouse(record.new!);
  },
});
```

### Scheduled tasks

Run a function every hour, every day, or on a cron schedule. No always-running container waiting for the next tick.

### Low-to-medium traffic

If your service handles fewer than ~1,000 requests per second, serverless is almost always cheaper and simpler than containers. Most startups, internal tools, and side projects fall into this category.

## When serverless doesn't work

### Long-running processes

Lambda has a 15-minute timeout. If your task takes longer — video encoding, ML training, large data migrations — use a container (ECS/Fargate) or a step function.

### Persistent connections

WebSockets work on API Gateway, but with limitations. If you need thousands of persistent connections (real-time chat, live dashboards), a container with a WebSocket server may be simpler.

### Consistent sub-10ms latency

Cold starts add 100-200ms on the first request after idle time. Warm invocations are fast (single-digit ms), but if you need guaranteed sub-10ms for every request, a running container avoids the cold start entirely.

### Very high throughput (>1000 rps sustained)

At very high sustained throughput, containers become cheaper per request. Lambda's per-invocation pricing adds up. The crossover point depends on your workload, but is typically around 1,000-5,000 requests per second sustained.

## The cost comparison

For a typical backend serving 500K requests/month:

| | Lambda | Fargate (1 task) | EC2 (t3.small) |
|---|---|---|---|
| Compute | $0 (free tier) | ~$30/month | ~$15/month |
| Idle cost | $0 | $30/month (runs 24/7) | $15/month (runs 24/7) |
| Scaling cost | Pay per extra request | Pay per extra task | Pay per extra instance |
| Ops cost | None | Docker, ECS config, ALB | SSH, systemd, AMIs, ALB |

Lambda is free for 1M requests/month. Containers cost money whether you use them or not.

For a service with 50M requests/month, the math shifts:
- **Lambda**: ~$10/month compute + DynamoDB costs
- **Fargate**: ~$60/month (2 tasks for redundancy)

Lambda is still competitive, but the gap narrows. At 500M requests/month, containers typically win on cost.

## Common concerns

### "But cold starts..."

Node.js cold starts on Lambda are 100-200ms. After that, the function stays warm for 5-15 minutes. For most APIs, users don't notice. Effortless keeps cold starts minimal by tree-shaking each handler's bundle and moving heavy dependencies to Lambda Layers.

If cold starts matter for your use case, AWS offers [Provisioned Concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html) — pre-warmed instances that eliminate cold starts entirely.

### "Vendor lock-in"

You're writing TypeScript functions that take input and return output. The business logic is portable. What's AWS-specific is the infrastructure wiring — and that's exactly what Effortless handles for you. If you ever move off Lambda, your handler logic stays the same; only the deployment changes.

### "I can't use my favorite database"

Lambda works with any database accessible over the network — RDS (Postgres, MySQL), ElastiCache (Redis), or external services (PlanetScale, Neon, Supabase). DynamoDB is the simplest choice (no connection pools, no VPC required, sub-millisecond latency), but it's not the only option.

### "Debugging is harder"

Different, not harder. Instead of SSH + logs on a server, you use CloudWatch Logs, X-Ray traces, and structured logging. Effortless includes built-in execution logging via the [platform table](/observability/) — every invocation is recorded automatically.

## The decision framework

Choose **serverless** if:
- You want to focus on code, not infrastructure
- Your traffic is variable or unpredictable
- You want zero idle cost
- Your requests complete in under 15 minutes
- You're building an API, webhook receiver, or event processor

Choose **containers** if:
- You need long-running processes (>15 min)
- You need persistent connections at scale
- You have sustained high throughput (>5,000 rps)
- You need full control over the runtime environment
- Your team already has container expertise and tooling

Choose **both** if:
- Your API is serverless but your background jobs need containers
- Most endpoints are Lambda, but one heavy endpoint runs on Fargate

They're not mutually exclusive. Many production systems use Lambda for APIs and ECS for long-running work.

## Next steps

- [Why AWS?](/why-aws/) — the specific AWS services Effortless uses and their guarantees
- [Why Effortless?](/why-effortless/) — why existing Lambda tooling is harder than it should be
- [Installation](/installation/) — deploy your first handler in 2 minutes
