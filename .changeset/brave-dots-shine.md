---
"effortless-aws": patch
---

Fix handler file pattern resolution: exact `.ts`/`.tsx` file paths in `handlers` config are now passed through as-is instead of being treated as directories

Fix static file resolution failing with EISDIR when glob patterns match directories (e.g. `defineSite` with nested `dist/` folder)
