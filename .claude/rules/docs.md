---
paths:
  - "docs/**"
  - "**/*.md"
---

## Documentation Guidelines

- Do NOT use Effect in documentation examples or code snippets. The framework is library-agnostic and does not impose any specific library on users.
- Use plain TypeScript in all code examples.
- If a schema/validation example is needed, prefer Zod. Effect Schema is acceptable only if the user explicitly requests it.
- Keep examples minimal and focused on the framework API itself, not on third-party libraries.
- Exception: architecture and internal implementation docs (e.g., `architecture.md`, `roadmap.md` design principles) may reference Effect since the framework internals genuinely use it.
