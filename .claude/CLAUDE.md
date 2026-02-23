Write all code, comments, commit messages, and documentation in English.

## Releases
- Release packages via changesets: add a `.changeset/<name>.md` file with the bump type and description.
- Do NOT edit `package.json` version directly.
- Publishing is handled by GitHub Actions — never run `changeset version` or `changeset publish` locally. Just push to main.

## Quality
- Run `pnpm typecheck` before pushing to verify there are no type errors.
- If `.git/hooks/pre-push` does not exist, create it with `pnpm typecheck` and `chmod +x`.

## AWS SDK
- Always use the generated Effect wrappers from `src/aws/clients/` for AWS SDK calls. Never instantiate AWS SDK clients directly.
- For calls to a different region, use `Effect.provide()` with the corresponding client's `.Default({ region })` layer.
