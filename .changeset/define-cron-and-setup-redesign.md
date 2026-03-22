---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

### New: `defineCron` — scheduled Lambda via EventBridge Scheduler

```typescript
export const cleanup = defineCron({ schedule: "rate(2 hours)" })
  .onTick(async () => { /* ... */ })

export const sync = defineCron({
  schedule: "cron(0 18 ? * MON-FRI *)",
  timezone: "Europe/Moscow",
})
  .deps(() => ({ orders }))
  .setup(async ({ deps }) => ({ db: deps.orders }), { memory: 512 })
  .onTick(async ({ db }) => { /* ... */ })
```

- `schedule` with typed rate expressions (`rate(5 minutes)`) and cron
- `timezone` with full IANA autocomplete (418 zones, DST-aware)
- Same builder pattern: `.deps()`, `.config()`, `.include()`, `.setup()`, `.onTick()`
- Deploy creates EventBridge Scheduler + Lambda + IAM roles

### API redesign: `.setup()` for Lambda config, `.include()` for static files

All handlers (`defineTable`, `defineApi`, `defineFifoQueue`, `defineBucket`, `defineCron`):

- **Lambda config moved to `.setup()`**: `memory`, `timeout`, `permissions`, `logLevel` are no longer in the options object
  - `.setup({ memory: 512, timeout: "5m" })` — lambda config only
  - `.setup(fn, { memory: 512 })` — init function + lambda config
- **`.include(glob)` replaces `static` option**: chainable, can be called multiple times
  - `.include("templates/*.html").include("assets/**")`

### Deploy output improvements

- Cron handlers shown in deploy summary with schedule expression and timezone
- Warnings (layer, bundle size) deferred until after progress spinner
