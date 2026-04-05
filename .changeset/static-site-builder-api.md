---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

- Refactor `defineDistribution` back to `defineStaticSite` with a builder pattern: `.route()`, `.middleware()`, `.build()`
- Replace `spa: boolean` option with unified `errorPage` field for custom error page handling
