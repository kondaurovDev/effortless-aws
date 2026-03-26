---
"effortless-aws": patch
---

Fix path parameter routing for Lambda Function URLs. Routes with `{param}` patterns (e.g. `/templates/{id}`) now correctly match incoming requests and extract parameters into `req.params` and `input`.
