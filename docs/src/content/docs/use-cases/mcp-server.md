---
title: MCP Server
description: Build AI-ready MCP servers with defineMcp — tools, resources, prompts, and auth.
---

You want to expose your backend to AI models — Claude, ChatGPT, Cursor, or any MCP-compatible client. Instead of building a custom API and writing adapter code, you define tools, resources, and prompts using the [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26) standard.

With `defineMcp` you declare what your server offers, export the handler, and get a production MCP endpoint backed by a Lambda Function URL. One Lambda handles all MCP protocol methods — initialize, tools, resources, prompts — over Streamable HTTP (JSON-RPC over POST).

Each tool, resource, and prompt is registered individually via singular builder methods: `.tool(def, handler)`, `.resource(def, handler)`, `.prompt(def, handler)`. All three are chainable and can be called repeatedly.

## A simple MCP server

You want to expose a "hello" tool that AI models can call.

```typescript
// src/greeter.ts
import { defineMcp } from "effortless-aws";

export const greeter = defineMcp({
  name: "greeter",
  instructions: "A friendly greeter. Use say_hello to greet someone by name.",
})
  .tool(
    {
      name: "say_hello",
      description: "Say hello to someone",
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    async (input) => ({
      content: [{ type: "text", text: `Hello, ${input.name}!` }],
    }),
  );
```

After `eff deploy`, you get a Function URL. Any MCP client can connect and discover the `say_hello` tool.

## Tools

Tools are functions the AI model decides when to call. Each tool has a `description` (how the model understands it), an `input` (JSON Schema — raw `McpInputSchema` or a `StandardJSONSchemaV1` like Zod's `z.object(...)`), and a handler (your code).

```typescript
import { defineMcp, defineTable } from "effortless-aws";

type Task = { tag: "task"; title: string; priority: "low" | "medium" | "high" };

export const tasksTable = defineTable<Task>().build();

export const api = defineMcp({
  name: "tasks",
  instructions: "Task manager. Use create_task to add tasks with title and priority.",
})
  .deps(() => ({ tasks: tasksTable }))
  .setup(({ deps }) => ({ db: deps.tasks }))
  .tool(
    {
      name: "create_task",
      description: "Create a new task",
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["title"],
      },
    },
    async (input, { db }) => {
      const id = crypto.randomUUID();
      await db.put({
        pk: "tasks", sk: `task#${id}`,
        data: { tag: "task", title: input.title, priority: input.priority ?? "medium" },
      });
      return { content: [{ type: "text", text: `Created task ${id}` }] };
    },
  );
```

Tool handlers return `McpToolResult` — an array of content blocks (`text`, `image`, or `resource`). If something goes wrong, return `isError: true`:

```typescript
.tool(
  {
    name: "get_task",
    description: "Get a task by id",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  async (input, { db }) => {
    const item = await db.get({ pk: input.id, sk: "profile" });
    if (!item) {
      return { content: [{ type: "text", text: "Not found" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(item.data) }] };
  },
);
```

## Resources

Resources are data that clients can pull into the model's context. They're read-only and identified by URIs.

**Static resources** have a fixed URI:

```typescript
.resource(
  {
    uri: "resource://schema",
    name: "Database Schema",
    description: "Available fields and types",
    mimeType: "application/json",
  },
  () => ({
    uri: "resource://schema",
    text: JSON.stringify({ pk: "string", sk: "string", data: "object" }),
  }),
)
```

**Resource templates** use URI parameters (RFC 6570) for dynamic data:

```typescript
.resource(
  {
    uri: "resource://users/{id}",
    name: "User Profile",
    description: "Fetch a user by ID",
  },
  async (params, { db }) => {
    const user = await db.get({ pk: params.id, sk: "profile" });
    return {
      uri: `resource://users/${params.id}`,
      text: user ? JSON.stringify(user.data) : "not found",
    };
  },
)
```

Pass `params` in the resource def (a Standard Schema like Zod) to get typed params in the handler — otherwise `params` is `Record<string, string>`.

Resources can return text or binary (`blob` with base64-encoded data). Handlers can return a single content object or an array.

## Prompts

Prompts are reusable templates that the client sends to its own LLM — your server doesn't run any model. Use prompts to share expert knowledge, domain-specific instructions, or multi-step workflows.

```typescript
.prompt(
  {
    name: "code_review",
    description: "Review code for best practices",
    args: [
      { name: "code", description: "The code to review", required: true },
      { name: "language", description: "Programming language" },
    ],
  },
  async (args) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `You are a senior ${args.language ?? "TypeScript"} developer. Review this code for bugs, performance, and best practices:\n\n${args.code}`,
      },
    }],
  }),
)
```

If the handler returns a plain string, it's auto-wrapped as a user message. Clients discover prompts via `prompts/list` and present them to users (e.g., as slash commands in Claude).

## Server instructions

The `instructions` field tells the client what your server does. It's included in the system prompt context so the model knows when to use your tools.

```typescript
export const mcp = defineMcp({
  name: "crm",
  instructions: "CRM server for managing contacts and deals. Use create_contact for new leads, search_contacts for lookups, and summarize_contact prompt for outreach.",
})
```

Good instructions help the model decide when to use your MCP server versus other available tools.

## Authentication

MCP servers are public by default. To restrict access, chain `.auth(...)` — the same builder used by `defineApi`. Pair it with a secret in `.config(...)` for the token:

```typescript
export const mcp = defineMcp({
  name: "secure-tools",
  instructions: "Protected tools server. Requires Bearer token authentication.",
})
  .config(({ defineSecret }) => ({
    token: defineSecret({ key: "mcp-token", generate: "hex:32" }),
  }))
  .auth<{ role: string }>(({ config }) => ({
    secret: config.token,
    apiToken: {
      verify: (value) => (value === config.token ? { role: "mcp-client" } : null),
    },
  }))
  .tool(
    { name: "protected_tool", description: "...", input: { type: "object", properties: {} } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
```

The token is auto-generated on first deploy and stored in SSM Parameter Store. Unauthenticated requests receive HTTP 401, per the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization).

Clients pass the token as a Bearer header:

```json
{
  "mcpServers": {
    "secure-tools": {
      "type": "http",
      "url": "https://your-function-url.lambda-url.region.on.aws/",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

## Full example

A contacts CRM with tools, resources, prompts, auth, and a shared database:

```typescript
import { defineMcp, defineTable } from "effortless-aws";

type Contact = { tag: "contact"; name: string; email: string; company?: string };

export const contacts = defineTable<Contact>().build();

export const mcp = defineMcp({
  name: "contacts",
  version: "1.0.0",
  instructions: "Contacts CRM. Manage contacts and generate outreach messages.",
})
  .deps(() => ({ contacts }))
  .config(({ defineSecret }) => ({
    token: defineSecret({ key: "mcp-token", generate: "hex:32" }),
  }))
  .auth<{ role: string }>(({ config }) => ({
    secret: config.token,
    apiToken: {
      verify: (t) => (t === config.token ? { role: "client" } : null),
    },
  }))
  .setup(({ deps }) => ({ db: deps.contacts }))
  .resource(
    {
      uri: "resource://schema",
      name: "Schema",
      mimeType: "application/json",
    },
    () => ({
      uri: "resource://schema",
      text: JSON.stringify({ name: "string", email: "string", company: "string?" }),
    }),
  )
  .resource(
    {
      uri: "resource://contacts/{id}",
      name: "Contact",
    },
    async (params, { db }) => {
      const item = await db.get({ pk: params.id, sk: "profile" });
      return { uri: `resource://contacts/${params.id}`, text: JSON.stringify(item?.data) };
    },
  )
  .prompt(
    {
      name: "outreach",
      description: "Generate a personalized outreach message",
      args: [{ name: "contactId", required: true }],
    },
    async (args, { db }) => {
      const item = await db.get({ pk: args.contactId, sk: "profile" });
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Draft a short outreach email for:\n${JSON.stringify(item?.data)}`,
          },
        }],
      };
    },
  )
  .tool(
    {
      name: "create_contact",
      description: "Create a new contact",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          company: { type: "string" },
        },
        required: ["id", "name", "email"],
      },
    },
    async (input, { db }) => {
      await db.put({
        pk: input.id, sk: "profile",
        data: { tag: "contact", name: input.name, email: input.email, company: input.company },
      });
      return { content: [{ type: "text", text: `Created ${input.id}` }] };
    },
  )
  .tool(
    {
      name: "get_contact",
      description: "Get a contact by ID",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    async (input, { db }) => {
      const item = await db.get({ pk: input.id, sk: "profile" });
      if (!item) return { content: [{ type: "text", text: "Not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(item.data) }] };
    },
  );
```

## Connecting clients

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "contacts": {
      "type": "http",
      "url": "https://your-function-url.lambda-url.region.on.aws/",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "contacts": {
      "url": "https://your-function-url.lambda-url.region.on.aws/",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

## See also

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26) — the full protocol reference
- [Definitions reference — defineMcp](/definitions/#definemcp) — all configuration options
- [Database](/use-cases/database/) — single-table design for `deps`
- [Authentication](/use-cases/authentication/) — `.auth()` patterns
