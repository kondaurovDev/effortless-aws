---
title: CLI Commands
description: Available CLI commands for deploying, managing, and debugging.
---

CLI available as `effortless` or short alias `eff`:

## deploy

Deploy all handlers to AWS.

```bash
npx effortless deploy [options]
npx eff deploy [options]

Options:
  --stage <name>     Deployment stage (default: "dev")
  --config <path>    Path to config file
  --only <names>     Deploy only specific handlers (comma-separated)
  --dry-run          Show what would be deployed without deploying
  --force            Delete orphaned resources (no matching handler)
  --verbose          Show detailed output
```

## destroy

Remove all deployed resources.

```bash
npx eff destroy [options]

Options:
  --stage <name>     Deployment stage
  --yes              Skip confirmation prompt
```

## dev

Local development with hot reload.

```bash
npx eff dev [options]

Options:
  --port <number>    Local server port (default: 3000)
```

## logs

Tail CloudWatch logs.

```bash
npx eff logs <handler-name> [options]

Options:
  --follow           Continuously poll for new logs
  --since <time>     Start time (e.g. "5m", "1h", "2024-01-01")
```

## list

List deployed handlers and their status.

```bash
npx eff list [options]

Options:
  --stage <name>     Deployment stage
```
