# Roadmap — Feature Ideas

Inspired by Encore, SST, and community feedback. Prioritized by impact on developer experience.

---

## Local Dev Server (`eff dev`)

**Priority: low**
**Inspiration: Encore `encore run`, SST dev**

Local HTTP server for API handlers with hot reload. No AWS, no deploy, no stub Lambdas.

```
eff dev
# → http://localhost:3000
# → watching src/ for changes
```

Scope:
- Spin up a local HTTP server that routes requests to `defineApi` handlers
- Hot reload on file save (esbuild watch or chokidar + dynamic import)
- Mock `deps` with local implementations (in-memory table client, local filesystem for buckets)
- Real `config` values fetched from SSM once on startup (or `.env.local` override)
- `setup()` runs on cold start, re-runs on reload

Why this is low priority:
- **Deploys are already fast (~5s)** — SST needs `sst dev` because CloudFormation takes minutes. Effortless doesn't have this problem.
- **Local mocks create false confidence** — in-memory DynamoDB will never match real DynamoDB behavior (consistency, limits, IAM). "Works locally, breaks on AWS" is worse than no local dev at all.
- **Tests are the right answer** — if you need confidence that something works, write a test. Tests are reliable and reproducible; manual localhost poking is not.
- **Only covers HTTP handlers** — event-driven handlers (streams, queues, S3 triggers) need real AWS anyway, so the local server helps with a fraction of the workflow.
- Could become relevant if Effortless adds webapp/frontend support where a dev server is genuinely needed for UI iteration.

---

## Cron Jobs (`defineCron`)

**Status: ✅ Implemented**
**Inspiration: Encore `new CronJob()`, Firebase `onSchedule`, SST `new Cron`**

Scheduled Lambda invocations via EventBridge Scheduler. Builder pattern consistent with `defineTable` / `defineApi`.

```typescript
// Minimal
export const cleanup = defineCron({ schedule: "rate(2 hours)" })
  .onTick(async () => {
    console.log("running cleanup")
  })

// Full — deps, config, setup
export const sync = defineCron({ schedule: "cron(0 9 * * ? *)" })
  .deps(() => ({ orders }))
  .config(({ defineSecret }) => ({ apiKey: defineSecret() }))
  .setup(async ({ deps, config }) => ({ db: deps.orders, key: config.apiKey }))
  .onError(({ error }) => console.error("sync failed", error))
  .onCleanup(async () => { /* release resources */ })
  .onTick(async ({ db, key }) => {
    await db.scan()   // cleanup expired orders
  })
```

AWS resources:
- EventBridge Scheduler rule (schedule expression)
- Lambda function (target)
- IAM role for Scheduler → Lambda invoke
- Standard Lambda execution role with permissions for deps

Implementation:
- Builder: `deps` → `config` → `setup` → `onError` → `onCleanup` → `onTick` (terminal)
- AST extraction for `schedule` expression (static string)
- Deploy: create/update EventBridge Scheduler + Lambda target
- Same deps/config/setup/files injection as other handlers
- `onTick` is the terminal method (like `onRecord` for tables)
- No `build()` — cron without a handler is meaningless

Minimal effort, high value — nearly every app needs scheduled tasks.

---

## Presigned URLs for Buckets

**Priority: medium**
**Inspiration: Encore signed URLs**

Add `presignGet(key, expiresIn)` and `presignPut(key, expiresIn)` to `BucketClient` for direct browser uploads/downloads without proxying through Lambda.

```typescript
const uploadUrl = await deps.uploads.presignPut("photo.jpg", { expiresIn: "5m" })
// return URL to frontend → browser uploads directly to S3
```

Implementation:
- `@aws-sdk/s3-request-presigner` + `GetObjectCommand` / `PutObjectCommand`
- Add to existing `BucketClient` in runtime
- No deploy changes needed — S3 permissions already granted

---

## Non-goals

These are things Encore does that don't fit effortless's philosophy:

- **Multi-cloud support** — effortless is AWS-native by design
- **Microservice orchestration** — effortless targets single-service serverless apps
- **Container-based deployment** — Lambda-only is a feature, not a limitation (cost, speed)
- **Managed cloud platform** — effortless deploys directly to user's AWS account, no middleman
- **Rust runtime** — Lambda cold starts are already fast with Node.js 24 + ARM64; the complexity isn't justified
- **SQL Database / Redis Cache** — VPC infrastructure contradicts the serverless-first philosophy; users who need Postgres can connect via `param("database-url")`
