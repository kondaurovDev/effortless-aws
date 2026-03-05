---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

feat: binary response support and response streaming for defineApi

- Add `binary` flag to `HttpResponse` for returning binary data (images, PDFs, etc.) with automatic `isBase64Encoded` handling
- Add `result` helpers (`result.json()`, `result.binary()`) for convenient response construction
- Add `stream: true` option to `defineApi` for Lambda response streaming and SSE support
- Add `ResponseStream` type with `write()`, `end()`, `sse()`, `event()` helpers injected into route args
- Deploy sets `InvokeMode: RESPONSE_STREAM` on Function URL when `stream: true`
- Backward compatible: streaming routes can still `return { status, body }` as before
