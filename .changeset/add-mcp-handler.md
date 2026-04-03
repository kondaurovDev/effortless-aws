---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

- Add `defineMcp` handler for building MCP (Model Context Protocol) servers with tools, resources, and prompts
- Add deployment support for MCP handlers via Lambda-backed Streamable HTTP endpoints
- Add `seed` and `sync` options to `defineBucket` for uploading local files to S3 on deploy
- Fix `effortless-aws` being incorrectly placed in Lambda layer instead of inlined in the bundle
