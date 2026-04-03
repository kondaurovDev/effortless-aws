---
paths:
  - "packages/effortless-aws-cli/src/**"
---

## AWS SDK usage rules

1. **Always use Effect wrappers** from `src/aws/clients/` for AWS SDK calls. Never instantiate AWS SDK clients directly (e.g. `new DynamoDBClient()`, `new S3Client()`).

2. **For cross-region calls**, use `Effect.provide()` with the corresponding client's `.Default({ region })` layer instead of creating a new client.

3. **No direct `@aws-sdk/*` imports** in service files. All AWS SDK access should go through the generated Effect client wrappers. Exception: files inside `src/aws/clients/` themselves.
