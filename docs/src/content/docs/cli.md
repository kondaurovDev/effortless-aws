---
title: CLI Commands
description: Available CLI commands for deploying, managing, and debugging.
---

Install globally (recommended):

```bash
npm install -g @effortless-aws/cli
```

CLI available as `effortless` or short alias `eff`:

### Quick start

```bash
# Deploy everything defined in your project
eff deploy

# Check what's deployed
eff status

# Remove a specific handler's resources
eff cleanup --handler createUser --all
```

### Typical workflow

1. Write handlers using `defineHttp`, `defineTable`, etc.
2. If handlers use `param()` for secrets — run `eff config` to set missing values
3. Run `eff deploy` — creates all AWS resources automatically (warns about missing parameters)
4. Remove or rename a handler → run `eff deploy` again (stale API routes are cleaned up)
5. To remove orphaned Lambdas/tables, run `eff cleanup` to see what's left, then `eff cleanup --all` to delete

:::tip
All commands read project name, stage, and region from `effortless.config.ts` — you rarely need to pass `--project` or `--region` manually.
:::

## deploy

Deploy handlers to AWS.

```bash
eff deploy [target] [options]
```

Without `target`, deploys all handlers matching patterns from `effortless.config.ts`.
With `target`, deploys a specific handler by name or file path.

```bash
# Deploy all handlers from config
eff deploy

# Deploy a specific file
eff deploy ./src/api.ts

# Deploy a specific handler by name
eff deploy createUser
```

**Options:**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--project <name>` | `-p` | Project name (or `name` in config) | from config |
| `--stage <name>` | `-s` | Deployment stage | `"dev"` |
| `--region <name>` | `-r` | AWS region | `"eu-central-1"` |
| `--verbose` | `-v` | Show detailed output | |

**What happens during deploy:**

- Creates or updates Lambda functions, IAM roles, and related resources for each handler
- Creates or updates API Gateway routes for HTTP and app handlers
- Creates or updates DynamoDB tables for table handlers
- Creates or updates SQS queues for FIFO queue handlers
- Uploads static sites to S3 + CloudFront
- Removes stale API Gateway routes that no longer have a matching handler
- Creates a shared dependency layer from `dependencies` in `package.json`
- Warns about missing SSM parameters declared via `param()` (see [`config`](#config))

:::note
If you remove a handler from your code, the API Gateway route will be cleaned up automatically on the next deploy. However, the Lambda function, IAM role, and other resources (DynamoDB tables, SQS queues, etc.) will remain in AWS. Use [`cleanup`](#cleanup) to remove orphaned resources.
:::

## status

Compare handlers in your code with what's deployed in AWS.

```bash
eff status [options]
```

Discovers handlers from your code and queries AWS resources by tags, then shows the diff:

- **new** — handler exists in code but hasn't been deployed yet
- **deployed** — handler is in both code and AWS (shows last deploy time, memory, timeout)
- **orphaned** — handler exists in AWS but was removed from code

```
Status for my-app/dev:

  new       [http]   createUser    POST  /api/users
  deployed  [http]   listExpenses  GET   /api/expenses  3m ago  256MB  30s
  deployed  [table]  expenses      1h ago
  orphaned  [http]   oldHandler

API: https://xxx.execute-api.eu-central-1.amazonaws.com
Total: 1 new, 2 deployed, 1 orphaned
```

:::tip
Orphaned handlers can be removed with `eff cleanup --handler <name> --all`.
:::

**Options:**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--project <name>` | `-p` | Project name (or `name` in config) | from config |
| `--stage <name>` | `-s` | Deployment stage | `"dev"` |
| `--region <name>` | `-r` | AWS region | `"eu-central-1"` |
| `--verbose` | `-v` | Show detailed output | |

## logs

Stream CloudWatch logs for a handler.

```bash
eff logs <handler> [options]
```

Shows recent logs from the handler's Lambda function. Use `--tail` to continuously poll for new logs.

```bash
# Show recent logs (last 5 minutes)
eff logs processOrder

# Tail logs in real time
eff logs processOrder --tail

# Show logs from last hour
eff logs processOrder --since 1h
```

Lambda metadata (request IDs, START/END/REPORT lines) is stripped for readability. Only the actual log output is shown.

**Options:**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--tail` | `-f` | Continuously poll for new logs | |
| `--since <duration>` | | How far back to start (`5m`, `1h`, `30s`) | `"5m"` |
| `--project <name>` | `-p` | Project name (or `name` in config) | from config |
| `--stage <name>` | `-s` | Deployment stage | `"dev"` |
| `--region <name>` | `-r` | AWS region | `"eu-central-1"` |
| `--verbose` | `-v` | Show detailed output | |

## cleanup

Delete deployed resources.

```bash
eff cleanup [options]
```

Lists all resources tagged by Effortless and deletes them. Requires either `--all` or `--handler` to actually delete — without them, just shows what would be deleted.

```bash
# Preview what would be deleted
eff cleanup --dry-run

# Delete all resources for the project
eff cleanup --all

# Delete resources for a specific handler
eff cleanup --handler createUser

# Clean up layer versions
eff cleanup --layer --dry-run
eff cleanup --layer --all

# Clean up orphaned IAM roles
eff cleanup --roles --dry-run
eff cleanup --roles --all
```

**Options:**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--handler <name>` | `-h` | Delete only this handler's resources | |
| `--layer` | | Clean up Lambda layer versions | |
| `--roles` | | Clean up orphaned IAM roles | |
| `--all` | | Delete all found resources (required without `--handler`) | |
| `--dry-run` | | Show what would be deleted without deleting | |
| `--project <name>` | `-p` | Project name (or `name` in config) | from config |
| `--stage <name>` | `-s` | Deployment stage | `"dev"` |
| `--region <name>` | `-r` | AWS region | `"eu-central-1"` |
| `--verbose` | `-v` | Show detailed output | |

## config

Manage SSM Parameter Store values used by your handlers.

Handlers declare config parameters via `config: { stripeKey: param("stripe/secret-key") }`. The CLI discovers all declared parameters from your code and helps you create, list, and update them in AWS.

```bash
# Interactive setup — prompts for each missing parameter
eff config

# List all parameters and their status
eff config list

# Set a specific parameter
eff config set stripe/secret-key
```

### Default (interactive setup)

```bash
eff config [options]
```

Discovers all `param()` declarations from your handlers, checks which SSM parameters exist, and interactively prompts for missing ones. Each value is stored as `SecureString`.

```
Missing parameters (my-service / dev)

? /my-service/dev/stripe/secret-key (checkout): sk_test_...
  ✓ created
? /my-service/dev/webhook-secret (checkout): whsec_...
  ✓ created

  Created 2 parameter(s) (SecureString)
```

Empty input skips the parameter.

### list

```bash
eff config list [options]
```

Shows all declared parameters with their status:

```
Config parameters (my-service / dev)

  ✓ checkout  /my-service/dev/stripe/secret-key  set
  ✗ checkout  /my-service/dev/webhook-secret      missing

  1 missing — run eff config to set them
```

### set

```bash
eff config set <key> [options]
```

Create or update a specific parameter. The full SSM path is built automatically: `/${project}/${stage}/${key}`.

```bash
eff config set stripe/secret-key --stage prod
# prompts for value, stores as SecureString at /my-service/prod/stripe/secret-key
```

**Options (all subcommands):**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--project <name>` | `-p` | Project name (or `name` in config) | from config |
| `--stage <name>` | `-s` | Deployment stage | `"dev"` |
| `--region <name>` | `-r` | AWS region | `"eu-central-1"` |
| `--verbose` | `-v` | Show detailed output | |

:::tip
`eff deploy` automatically warns about missing parameters before deploying. You don't need to run `eff config list` separately — just deploy and follow the hint.
:::

## layer

Show or build the dependency layer.

Effortless automatically creates a shared Lambda layer from your `dependencies` in `package.json`. This command shows what will be included and optionally builds it locally for debugging.

```bash
# Show layer info (default)
eff layer

# Build layer locally for debugging
eff layer --build
```

**Options:**

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--build` | | Build layer directory locally | |
| `--output <dir>` | `-o` | Output directory (with `--build`) | `".effortless"` |
| `--verbose` | `-v` | Show all packages | |
