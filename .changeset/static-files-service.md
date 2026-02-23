---
"effortless-aws": minor
---

Replace `readStatic` with `files` service for static file access

- **Breaking:** `readStatic(path)` callback argument replaced with `files` service object (`StaticFiles` type)
- `files.read(path)` — read file as UTF-8 string (same as old `readStatic`)
- `files.readBuffer(path)` — read file as Buffer for binary content
- `files.path(path)` — resolve absolute path to the bundled file
- `files` is now injected into `setup()` as well (previously only available in handler callbacks)
