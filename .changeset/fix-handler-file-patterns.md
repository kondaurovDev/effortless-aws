---
"effortless-aws": patch
---

Fix handler file pattern resolution: exact `.ts`/`.tsx` file paths in `handlers` config are now passed through as-is instead of being treated as directories
