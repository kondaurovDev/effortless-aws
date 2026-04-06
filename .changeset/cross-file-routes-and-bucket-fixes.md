---
"@effortless-aws/cli": minor
---

- Fix cross-file route origin resolution: `discoverHandlers` now resolves API/MCP/bucket handlers imported from other files via `__brand` + `__spec` matching
- Fix S3 bucket name generation: export names with uppercase letters (e.g. `publicFiles`) are now lowercased for S3 compliance
- Remove CloudFront prefix stripping for bucket routes: full URL path is forwarded to S3 origin, matching industry standard behavior (breaking change for bucket routes that relied on prefix stripping)
