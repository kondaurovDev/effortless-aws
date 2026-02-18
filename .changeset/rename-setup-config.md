---
"effortless-aws": minor
---

Rename handler options for clarity: `context` → `setup`, `params` → `config`

**Breaking changes:**
- Handler config property `context` is now `setup` (callback arg `ctx` unchanged)
- Handler config property `params` is now `config` (SSM parameter declarations)
- Type `ResolveParams<P>` is now `ResolveConfig<P>`

**New:**
- `setup` factory now receives `deps` and `config` as arguments (previously only received `params`)
- `config` accepts plain strings as SSM keys: `config: { dbUrl: "database-url" }` — no `param()` import needed for simple cases
