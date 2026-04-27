---
"effortless-aws": minor
---

defineApi: auto-detect binary response bodies, add `downloadAs` for forcing downloads, rename `files.readBuffer` → `files.readBytes`.

- `body: Uint8Array | Buffer | Blob` is now detected automatically — the runtime base64-encodes it and sets `isBase64Encoded: true`. `Blob.type` is used as `Content-Type` when not set explicitly. The legacy `binary: true` flag with a base64 string body still works.
- New `downloadAs?: string` response field sets `Content-Disposition: attachment; filename="<value>"`. Works with any body type (JSON, text, binary). Non-ASCII filenames get an RFC 5987 `filename*=UTF-8''…` form for compatibility. An explicit `Content-Disposition` header overrides `downloadAs`.
- **Breaking:** `files.readBuffer(path): Buffer` renamed to `files.readBytes(path): Uint8Array` for cross-platform typing. The implementation still uses `readFileSync` under the hood, and `Buffer` methods remain available on the returned value (since `Buffer extends Uint8Array`) — only the static type changed.

Example:

```ts
.get({ path: "/script/shortcut" }, ({ files }) => ({
  status: 200,
  body: files.readBytes("infra/static/budget-shortcut.signed.shortcut"),
  downloadAs: "family-budget.shortcut",
}))
```
