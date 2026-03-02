# @effortless-aws/cli

[![npm version](https://img.shields.io/npm/v/@effortless-aws/cli)](https://www.npmjs.com/package/@effortless-aws/cli)

CLI and deploy tooling for [effortless-aws](https://www.npmjs.com/package/effortless-aws). Deploys Lambda functions, API Gateway routes, DynamoDB tables, SQS queues, S3 buckets, and CloudFront sites directly via AWS SDK — no CloudFormation, no state files.

```bash
npm install -D @effortless-aws/cli
```

## Commands

| Command | Description |
|---------|-------------|
| `eff deploy` | Build and deploy all handlers to AWS |
| `eff build` | Bundle handlers without deploying |
| `eff status` | Show deployed resources and their status |
| `eff logs` | Tail CloudWatch logs for a handler |
| `eff config` | Manage SSM parameters |
| `eff layer` | Manage shared Lambda layers |
| `eff cleanup` | Remove orphaned AWS resources |

## Usage

```bash
# Deploy everything
npx eff deploy

# Deploy to a specific stage
npx eff deploy --stage production

# View logs
npx eff logs --handler hello
```

## How it works

1. Scans your TypeScript files for exported handler definitions
2. Bundles each handler with esbuild
3. Deploys directly via AWS SDK (IAM roles, Lambda functions, API Gateway routes, etc.)
4. Tags all resources for tracking — no external state files needed

## Documentation

Full docs: **[effortless-aws.website](https://effortless-aws.website)**

## License

MIT
