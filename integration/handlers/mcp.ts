import { defineMcp } from "effortless-aws";
import { z } from "zod/v4";
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
  .resource({
    uri: "resource://contacts/{id}",
    name: "Contact by ID",
    description: "Retrieve a single contact",
    params: z.object({ id: z.string() }),
  }, async (params, { db }) => {
    const item = await db.get({ pk: params.id, sk: "profile" });
    return item?.data ?? null;
  })
  .prompt({
    name: "summarize_contact",
    description: "Summarize a contact's profile for outreach",
    args: z.object({ contactId: z.string().describe("Contact ID") }),
  }, async (args, { db }) => {
    const item = await db.get({ pk: args.contactId, sk: "profile" });
    const info = item ? JSON.stringify(item.data) : "Contact not found";
    return `You are a sales assistant. Summarize the following contact and suggest a personalized outreach message.\n\nContact data:\n${info}`;
  })
  .tool({
    name: "list_contacts",
    description: "List all contacts",
    input: z.object({}),
  }, async (_input, { db }) => {
    return db.query({ pk: "contacts" });
  })
  .tool({
    name: "get_contact",
    description: "Get a contact by ID",
    input: z.object({
      id: z.string().describe("Contact ID"),
    }),
  }, async (input, { db }) => {
    const item = await db.get({ pk: input.id, sk: "profile" });
    if (!item) throw new Error("Contact not found");
    return item.data;
  })
  .tool({
    name: "create_contact",
    description: "Create a new contact",
    input: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      company: z.string().optional(),
    }),
  }, async (input, { db }) => {
    await db.put({
      pk: input.id,
      sk: "profile",
      data: { tag: "contact", name: input.name, email: input.email, company: input.company },
    });
    return `Created contact ${input.id}`;
  });
