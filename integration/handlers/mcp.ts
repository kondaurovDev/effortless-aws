import { defineMcp } from "effortless-aws";
import { db } from "./table";

// ── MCP server ───────────────────────────────────────────────

export const mcp = defineMcp({
  name: "contacts",
  version: "1.0.0",
  instructions: "Contacts CRM server. Use tools to create, read, and list contacts. Use the summarize_contact prompt to generate personalized outreach messages.",
})
  .deps(() => ({ db }))
  .config(({ defineSecret }) => ({
    mcpToken: defineSecret({ key: "mcp-token", generate: "hex:32" }),
  }))
  .setup(({ deps, config, enableAuth }) => ({
    db: deps.db,
    auth: enableAuth({
      secret: config.mcpToken,
      apiToken: {
        verify: async (token: string) => {
          if (token === config.mcpToken) return { role: "mcp-client" };
          return null;
        },
      },
    }),
  }))
  .resources(({ db }) => ({
    "resource://schema": {
      name: "Contacts Schema",
      description: "Fields available in the contacts table",
      mimeType: "application/json",
      handler: () => ({
        uri: "resource://schema",
        text: JSON.stringify({
          pk: "string (contact ID)",
          sk: "string (sort key)",
          data: { name: "string", email: "string", company: "string?" },
        }),
      }),
    },
    "resource://contacts/{id}": {
      name: "Contact by ID",
      description: "Retrieve a single contact",
      handler: async (params: Record<string, string>) => {
        const arr = 1234455
        console.log('up!!!')
        const id = params.id!;
        const item = await db.get({ pk: id, sk: "profile" });
        return {
          uri: `resource://contacts/${id}`,
          text: item ? JSON.stringify(item.data) : "not found",
        };
      },
    },
  }))
  .prompts(({ db }) => ({
    summarize_contact: {
      description: "Summarize a contact's profile for outreach",
      arguments: [
        { name: "contactId", description: "Contact ID", required: true },
      ],
      handler: async (args) => {
        const item = await db.get({ pk: args.contactId!, sk: "profile" });
        const info = item ? JSON.stringify(item.data) : "Contact not found";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `You are a sales assistant. Summarize the following contact and suggest a personalized outreach message.\n\nContact data:\n${info}`,
              },
            },
          ],
        };
      },
    },
  }))
  .tools(({ db }) => ({
    list_contacts: {
      description: "List all contacts",
      input: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const items = await db.query({ pk: "contacts" });
        return {
          content: [{ type: "text", text: JSON.stringify(items) }],
        };
      },
    },
    get_contact: {
      description: "Get a contact by ID",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Contact ID" } },
        required: ["id"],
      },
      handler: async (input) => {
        const item = await db.get({ pk: input.id, sk: "profile" });
        if (!item) {
          return { content: [{ type: "text", text: "Contact not found" }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(item.data) }] };
      },
    },
    create_contact: {
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
      handler: async (input) => {
        await db.put({
          pk: input.id,
          sk: "profile",
          data: { tag: "contact", name: input.name, email: input.email, company: input.company },
        });
        return { content: [{ type: "text", text: `Created contact ${input.id}` }] };
      },
    },
  }));
