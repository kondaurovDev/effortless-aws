---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Reconcile stale resources on deploy when a handler switches to resource-only mode, and add `.build()` to `defineQueue`.

**The problem.** The deploy pipeline was forward-only — it created whatever the config asked for, but didn't remove what a previous deploy had created when the config shrank. Switching `defineTable().onRecord(...)` → `defineTable().build()` (or the bucket equivalent) left the Lambda, DLQ, IAM role, and event-source mapping orphaned in AWS. Users had to run `cleanup --stale` to get rid of them.

**What changes.**

- **Resource registry** (`@effortless-aws/cli`): `ResourceSpec` gains a `requiresHandler` flag marking resources that only exist when a handler function is attached. A new `cleanupStaleHandlerResources(handlerType, ctx)` helper deletes just those.
- **Deploy paths** (`@effortless-aws/cli`): `deploy-table.ts`, `deploy-bucket.ts`, and `deploy-queue.ts` call the helper in their `!hasHandler` branches. The primary resource (table / bucket / queue) is preserved; Lambda + IAM (+ DLQ for tables) are removed if they existed from a previous deploy.
- **Bucket notification** (`@effortless-aws/cli`): added `clearBucketNotification` — in resource-only mode the S3 bucket's `NotificationConfiguration` is cleared so it no longer points at a deleted Lambda.
- **Stream reconcile** (`@effortless-aws/cli`): `ensureTable` now reconciles the DynamoDB stream spec (enable / disable / change view) rather than only enabling it. Combined with the above, switching a table to `.build()` correctly disables the stream.
- **`defineQueue.build()`** (`effortless-aws`): new terminal on the queue builder that finalizes a resource-only SQS queue (no Lambda). Useful when the queue is consumed by an external system — an ECS worker, another account, etc.
- **MCP warning** (`@effortless-aws/cli`): `deploy` now logs a warning when an MCP handler has no tools, resources, or prompts registered.

**Behavioral note.** Resource-only tables and buckets will, on the next deploy, actively remove any satellite resources left over from previous deploys. If you had a stream or notification wired to something outside of this CLI's management, re-check after deploying.
