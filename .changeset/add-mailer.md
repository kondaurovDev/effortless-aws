---
"effortless-aws": minor
---

Add `defineMailer` for sending emails via Amazon SES. Declare a domain, get a typed `EmailClient` injected into any handler via `deps` with automatic IAM wiring and DKIM setup. Also adds SES identity cleanup support to `eff cleanup`.
