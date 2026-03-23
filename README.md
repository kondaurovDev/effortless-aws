# effortless-aws

[![npm version](https://img.shields.io/npm/v/effortless-aws)](https://www.npmjs.com/package/effortless-aws)
[![npm downloads](https://img.shields.io/npm/dw/effortless-aws)](https://www.npmjs.com/package/effortless-aws)

**Write a TypeScript handler. Export it. Deploy. That's it.**

No CloudFormation. No Terraform. No YAML. No state files. Lambda, DynamoDB, IAM — all created from your code in ~10 seconds.

```typescript
import { defineApi } from "effortless-aws";

export const hello = defineApi({ basePath: "/hello" })
  .get("/", async ({ ok }) => ok({ message: "Hello!" }));
```

```bash
npx eff deploy   # ~10 seconds
```

One file. One command. Lambda + Function URL + IAM role created automatically.

## Getting started

```bash
npm install effortless-aws
npm install -D @effortless-aws/cli
```

Full docs, examples, and API reference: **[effortless-aws.website](https://effortless-aws.website)**

## License

MIT
