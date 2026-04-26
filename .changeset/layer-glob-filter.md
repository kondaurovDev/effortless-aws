---
"@effortless-aws/cli": patch
---

Strip non-runtime files from the dependency layer zip (type declarations, sourcemaps, `src/`, tests, examples, docs, `tsconfig*.json`). Mix the packing-logic fingerprint into the layer hash so existing deployments pick up the smaller layer on the next deploy without a manual cache bust. On a typical Effect + Zod project this drops the published layer from ~10 MB to ~3.5 MB and avoids the S3 fallback for direct upload.
