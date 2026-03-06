Write all code, comments, commit messages, and documentation in English.

## Monorepo
- This is a pnpm workspace monorepo (see `pnpm-workspace.yaml`). Packages live in `packages/`.
- Use the pnpm `catalog:` protocol for dependency versions shared across multiple packages. Catalog versions are defined in `pnpm-workspace.yaml`.
- Install dev dependencies into the specific package (`pnpm add -D <pkg> --filter <package-name>`), not the workspace root.

## Releases
- Release packages via changesets: add a `.changeset/<name>.md` file with the bump type and description.
- Package names for changesets (must match `package.json#name` exactly):
  - `effortless-aws` — `packages/effortless-aws` (runtime library)
  - `@effortless-aws/cli` — `packages/effortless-aws-cli` (CLI tool)
- Do NOT edit `package.json` version directly.
- Never use `major` bump in changesets unless the user explicitly asks for it. Default to `minor` for new features and breaking changes, `patch` for fixes.
- Publishing is handled by GitHub Actions — never run `changeset version` or `changeset publish` locally. Just push to main.

## Quality
- Run `pnpm typecheck` before pushing to verify there are no type errors.

## Protected files
- Do NOT modify `CHANGELOG.md` files — they contain release history and are managed by changesets.

## Public API (`effortless-aws`)
- Only export types from `index.ts` that users need directly. Do NOT export internal types (callback fn types like `TableRecordFn`, options types like `DefineTableOptions`, utility types like `ResolveDeps`, `ResolveConfig`, `AnyParamRef`).
- Handler return types (`TableHandler`, `FifoQueueHandler`, etc.) should only carry generics needed externally (e.g. `T` for schema). Internal generics (`D`, `P`, `S` for deps/config/static) must stay local to the `define*` function — never leak into the return type.

## AWS SDK
- Always use the generated Effect wrappers from `src/aws/clients/` for AWS SDK calls. Never instantiate AWS SDK clients directly.
- For calls to a different region, use `Effect.provide()` with the corresponding client's `.Default({ region })` layer.
