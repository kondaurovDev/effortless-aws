---
"@effortless-aws/cli": patch
---

Internal refactoring: extract CliContext and resource registry, replace `execSync` with Effect `Command` for app/site builds, use `@effect/platform` Path/FileSystem instead of Node builtins, simplify tag generation, add ECS/S3/SQS cleanup functions.
