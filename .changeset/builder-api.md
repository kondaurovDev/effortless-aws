---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

Redesign handler API to builder pattern with per-step type inference

- **defineApi**: single options object `defineApi({ basePath })`, chained route methods `.get()/.post()/.put()/.patch()/.delete()` instead of `.routes([])` array
- **defineTable/defineFifoQueue/defineBucket**: builder pattern with `.deps()`, `.config()`, `.setup()` methods instead of curried `define*()({...})` syntax
- **Terminal methods**: `.onRecord()`, `.onMessage()`, `.onObjectCreated()`, `.routes()` finalize the handler — no `.build()` needed (except resource-only)
- **Response helpers**: `ok(body, status?)` and `fail(message, status?)` injected into route args, setup, and onError — replaces `result.json()`
- **onCleanup**: renamed from `onAfterInvoke`, moved to builder method with setup context access
- **CLI warning**: detect unfinalized builders and suggest the correct terminal method
