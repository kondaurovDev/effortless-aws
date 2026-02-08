# CLI Roadmap

Planned CLI commands to improve the development workflow. The goal: fast feedback loop without leaving the terminal.

---

## eff invoke

Call a deployed handler with a payload from the terminal.

```bash
npx eff invoke processOrder --payload '{"orderId": "abc-123"}'
npx eff invoke createOrder --method POST --body '{"item": "laptop"}'
npx eff invoke processOrder --payload-file event.json
```

**Status**: Planned

---

## eff logs

Stream CloudWatch logs in human-readable format with colors and filtering.

```bash
npx eff logs processOrder --tail
npx eff logs processOrder --level error
npx eff logs --tail  # all handlers
```

**Status**: Planned

---

## eff diff

Show what will change before deploying (like `terraform plan`).

```bash
npx eff diff
# ~ processOrder    code updated (hash changed)
# + newHandler       new Lambda + SQS queue
# - oldHandler       removed (not in code)
```

**Status**: Planned
