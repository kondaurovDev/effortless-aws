---
paths:
  - "docs/**"
---

## Documentation Guidelines

- Do NOT use Effect in documentation examples or code snippets. The framework is library-agnostic and does not impose any specific library on users.
- Use plain TypeScript in all code examples.
- If a schema/validation example is needed, prefer Zod. Effect Schema is acceptable only if the user explicitly requests it.
- Keep examples minimal and focused on the framework API itself, not on third-party libraries.
- Exception: architecture and internal implementation docs (e.g., `architecture.md`, `roadmap.md` design principles) may reference Effect since the framework internals genuinely use it.

## Tone and style

- Conversational, second-person style ("You need a backend API...").
- Avoid jargon, keep sentences short.
- Read at least 2-3 existing pages before writing new ones. Reference: `docs/src/content/docs/use-cases/http-api.md`.

## Use-case page structure

Follow the pattern: problem statement → minimal example → progressive enhancement (deps, config, streams) → deploy output.

## Frontmatter format

```yaml
---
title: Page Title
description: One-line description for SEO and sidebar.
---
```

## Before writing

1. Check the runtime source in `packages/effortless-aws/src/` for the actual API surface.
2. Check `packages/effortless-aws/src/index.ts` to see what is publicly exported.

## After writing

1. Verify all code examples are valid TypeScript (no Effect imports, correct API usage).
2. Check that referenced handler names and options match the current codebase.
