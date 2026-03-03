---
"@effortless-aws/cli": patch
---

Warn about TypeScript entry points in production dependencies that cause ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING at runtime; show dependency warnings in `eff status` output; fail deploy early when a handler deps key references a missing table/bucket/mailer handler
