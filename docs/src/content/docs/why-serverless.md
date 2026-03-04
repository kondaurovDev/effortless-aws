---
title: Why serverless?
description: Why serverless is the fastest way to ship a product — and why Effortless builds on AWS.
---

## The serverless model

Serverless means you don't manage servers, you don't pay for idle, and your infrastructure scales automatically. You write code, deploy it, and the cloud provider handles everything else — provisioning, scaling, patching, availability.

This isn't unique to AWS. GCP has Cloud Functions and Cloud Run. Azure has Azure Functions. Cloudflare has Workers. The model itself is what matters:

- **Pay per use** — zero traffic = zero cost. No minimum instances, no idle servers.
- **Scale to zero** — nothing runs when nobody is using your product.
- **Scale to anything** — thousands of concurrent requests handled automatically.
- **Zero ops** — no OS updates, no capacity planning, no container orchestration.
- **Multi-AZ by default** — your code runs across multiple data centers without any configuration.

For shipping a product, this is the ideal foundation. You focus on what your product does — the platform handles how it runs.

## Why it matters for product delivery

Traditional infrastructure (even managed containers like ECS or Cloud Run) requires upfront decisions about capacity, networking, and scaling policies. You're solving infrastructure problems before you've validated the product.

Serverless removes that overhead. You can go from idea to deployed product without thinking about infrastructure at all:

- Need an API? Write a handler, deploy. It's live.
- Need a database? Define a table, deploy. It's provisioned.
- Need background processing? Define a queue consumer, deploy. It's wired.

Every resource is created on demand, scales independently, and costs nothing at rest. This is what makes it possible to ship an entire product — API, database, website, queues, email — in a single deploy.

## Why AWS

All major clouds have serverless offerings. Effortless builds on AWS because it has the most complete serverless ecosystem — not just compute, but the full stack of services a product needs:

| Product need | AWS service | On-demand? | Free tier |
|---|---|---|---|
| Compute | Lambda | Per-invocation | 1M requests/month |
| HTTP endpoints | Lambda Function URLs | Included with Lambda | Free |
| Database | DynamoDB | Per-request | 25 GB storage |
| Message queues | SQS FIFO | Per-message | 1M requests/month |
| File storage | S3 | Per-request + per-GB | 5 GB storage |
| Email | SES | Per-email | 62,000 emails/month |
| CDN | CloudFront | Per-request + per-GB | 1 TB transfer/month |
| Secrets | SSM Parameter Store | Free (standard) | Unlimited |

**Real cost for small-medium products: $0–5/month.** Everything on this list scales to production traffic without changing configuration.

### Complete serverless stack

AWS is the only platform where compute, database, queues, storage, email, and CDN are all first-party serverless services under one account, one SDK, one billing.

- **Vercel / Cloudflare** — great for compute, but you need external services for databases, queues, and email.
- **GCP** — has Cloud Functions and Firestore, but the ecosystem is fragmented across Cloud Run, Cloud Functions, and App Engine. Cloud Functions 2nd gen requires container builds (1–3 min deploys).
- **AWS** — one SDK, one account, all services. No third-party dependencies for a complete product backend.

### Fast deploys

| Platform | Deploy model | Time |
|---|---|---|
| AWS Lambda | ZIP upload | 3–5 seconds |
| Vercel Functions | ZIP upload | 5–15 seconds |
| Cloudflare Workers | JS bundle | 1–3 seconds |
| GCP Cloud Functions (2nd gen) | Container build | 1–3 minutes |

AWS Lambda runs on Firecracker microVMs with pre-built runtimes. Upload a ZIP — Lambda runs immediately. No container builds, no image registry.

### Mature and predictable

- 17+ years of production use
- Battle-tested at massive scale (Netflix, Airbnb, thousands of startups)
- Stable APIs — no breaking changes
- Large community and talent pool

### Trade-offs

No platform is perfect:

- **Cloudflare Workers** — faster cold starts (0ms), but no integrated database, queues, or email.
- **Vercel** — simpler DX for frontend projects, but limited backend services.
- **GCP** — competitive services, but slower deploys and fragmented serverless story.

AWS has the deepest serverless ecosystem, which is why Effortless builds on it. For framework-level comparisons (SST, Nitric, Serverless Framework), see [Comparisons](/comparisons/).

## AWS services in Effortless

### Lambda

[AWS Lambda](https://aws.amazon.com/lambda/) runs your handler code. Each invocation gets an isolated execution environment.

- Runs across multiple availability zones automatically
- Scales from zero to thousands of concurrent executions
- Cold starts on Node.js are typically 100–200ms, warm invocations respond in single-digit milliseconds

### Lambda Function URLs

[Lambda Function URLs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html) provide built-in HTTPS endpoints for `defineApi` handlers — no API Gateway needed.

- Integrated directly into Lambda — no additional service to manage
- TLS termination and CORS built in
- No additional cost beyond Lambda invocation pricing

### DynamoDB

[DynamoDB](https://aws.amazon.com/dynamodb/) stores your data. Every table created by `defineTable` runs in on-demand mode.

- Data replicated across three availability zones
- Single-digit millisecond latency at any scale
- 99.999% availability SLA
- No connection pools, no vacuuming, no version upgrades
- **DynamoDB Streams** turn every write into a real-time event — your `onRecord` handler runs automatically

### SQS FIFO

[SQS FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html) power `defineFifoQueue` — fully managed message queues with exactly-once processing and strict ordering.

- Guaranteed message delivery with configurable retention
- No servers to manage, no Kafka clusters to tune

### CloudFront + S3

[CloudFront](https://aws.amazon.com/cloudfront/) is a global CDN used by `defineApp` and `defineStaticSite`.

- 450+ edge locations globally
- S3 bucket is private — accessed only through CloudFront Origin Access Control

### SSM Parameter Store

[SSM Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) stores secrets referenced via `param()`.

- Regional, replicated across AZs
- `SecureString` parameters encrypted with KMS
- Values fetched once per Lambda cold start and cached

## The hard part isn't the services

The services themselves are well-designed. The hard part is wiring them into a product — IAM policies for every connection, event source mappings, environment variables, CloudFormation stacks. This is the problem [Effortless](/why-effortless/) solves: you define handlers in TypeScript, and all the wiring happens automatically.

Effortless auto-wires the connective tissue that you'd normally configure manually:

- **IAM roles and policies** — every Lambda gets its own role with least-privilege permissions
- **CloudWatch Logs** — attached to every handler automatically
- **DynamoDB access** — table handlers get full access; `deps: { orders }` grants access to dependent tables
- **SSM access** — `config: { key: param("...") }` grants `ssm:GetParameter` and `ssm:GetParameters`
- **SQS access** — queue handlers get permissions to receive and delete messages
- **Lambda Function URLs** — HTTPS endpoints with CORS attached to your Lambda functions
- **Event source mappings** — DynamoDB Streams → Lambda and SQS → Lambda with partial batch failure reporting

## What you're responsible for

- **Handler code** — business logic, error handling, input validation
- **SSM parameters** — creating the actual secrets in Parameter Store before deploying
- **DynamoDB schema design** — choosing partition keys and access patterns
