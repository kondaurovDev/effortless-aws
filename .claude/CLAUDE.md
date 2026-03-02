Write all code, comments, commit messages, and documentation in English.

## Monorepo
- This is a pnpm workspace monorepo (see `pnpm-workspace.yaml`). Packages live in `packages/`.
- Use the pnpm `catalog:` protocol for dependency versions shared across multiple packages. Catalog versions are defined in `pnpm-workspace.yaml`.
- Install dev dependencies into the specific package (`pnpm add -D <pkg> --filter <package-name>`), not the workspace root.

## Releases
- Release packages via changesets: add a `.changeset/<name>.md` file with the bump type and description.
- Do NOT edit `package.json` version directly.
- Publishing is handled by GitHub Actions — never run `changeset version` or `changeset publish` locally. Just push to main.

## Quality
- Run `pnpm typecheck` before pushing to verify there are no type errors.

## AWS SDK
- Always use the generated Effect wrappers from `src/aws/clients/` for AWS SDK calls. Never instantiate AWS SDK clients directly.
- For calls to a different region, use `Effect.provide()` with the corresponding client's `.Default({ region })` layer.
