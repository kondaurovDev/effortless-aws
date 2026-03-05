---
"effortless-aws": major
"@effortless-aws/cli": major
---

**BREAKING:** Lambda settings (`memory`, `timeout`, `logLevel`, `permissions`) moved from top-level handler options into a nested `lambda` object. Global config `defaults` renamed to `lambda`.

```typescript
// Before
defineFifoQueue({ memory: 512, timeout: '1m', delay: '2s' })
defineConfig({ defaults: { memory: 256 } })

// After
defineFifoQueue({ lambda: { memory: 512, timeout: '1m' }, delay: '2s' })
defineConfig({ lambda: { memory: 256 } })
```
