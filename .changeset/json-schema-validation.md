---
"effortless-aws": minor
"@effortless-aws/cli": patch
---

- Add Standard Schema support to `defineApi` routes via an optional `schema` field for input validation
- Add Standard Schema support to `defineMcp` tools for typed input validation
- Export new `McpEntries` type and rename `McpToolDef` to use `McpToolDefInput` internally
- Fix lint errors (unused imports/variables) and remove outdated MCP tests
