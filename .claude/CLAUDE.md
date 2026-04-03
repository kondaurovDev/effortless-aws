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

## Agents
- Running tests and typechecks → `test-runner`
- Writing missing tests after code changes → `test-writer`
- Scaffolding new `define*` handler types → `handler-scaffold`
- Creating changeset files for releases → `release`
- Reviewing branch diff against main → `review`
- Fixing typecheck errors + tests + changeset before merge → `prepare-release`
