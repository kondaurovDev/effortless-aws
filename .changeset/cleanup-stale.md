---
"@effortless-aws/cli": minor
---

Rework `eff cleanup` command: replace `--orphaned` with `--stale` for smarter resource detection, add interactive confirmation prompts, and remove `--roles` and `--layer` flags.

- `--stale` detects stale handlers (in AWS but not in code), stale individual resources (e.g. IAM role without its Lambda), and unused Lambda layer versions
- All destructive actions now require confirmation via interactive prompt (`--yes`/`-y` to skip)
- Scheduler resources are now discovered via name-based listing (not affected by Resource Groups Tagging API gaps)
- Rename "orphaned" to "stale" in `eff status` for consistency
