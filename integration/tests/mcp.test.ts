import { describe, it, expect, beforeAll } from "vitest";
import { env } from "../env";

const mcpUrl = () => env.mcpUrl;

let token: string;

const rpc = async (method: string, params?: Record<string, unknown>) => {
  const res = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return res.json() as Promise<{ jsonrpc: string; id: number; result?: any; error?: any }>;
};

const rpcRaw = async (method: string, headers?: Record<string, string>) => {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
};

beforeAll(() => {
  if (!env.mcpUrl) {
    throw new Error(
      "MCP_URL is not set. Deploy first:\n  cd integration && pnpm eff deploy"
    );
  }
  if (!env.mcpToken) {
    throw new Error("MCP_TOKEN is not set. Add mcpToken to deploy.local.json.");
  }
  token = env.mcpToken;
});

// ── Auth ──────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects request without token", async () => {
    const res = await rpcRaw("tools/list");
    expect(res.status).toBe(401);
  });

  it("rejects request with invalid token", async () => {
    const res = await rpcRaw("tools/list", { "Authorization": "Bearer invalid-token" });
    expect(res.status).toBe(401);
  });

  it("accepts request with valid token", async () => {
    const res = await rpcRaw("tools/list", { "Authorization": `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
});

// ── Protocol ──────────────────────────────────────────────────

describe("protocol", () => {
  it("GET returns server info (no auth required)", async () => {
    const res = await fetch(mcpUrl());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result.name).toBe("contacts");
    expect(body.result.version).toBe("1.0.0");
    expect(body.result.protocol).toBe("mcp");
  });

  it("initialize returns capabilities", async () => {
    const body = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.capabilities).toHaveProperty("resources");
    expect(body.result.capabilities).toHaveProperty("prompts");
    expect(body.result.instructions).toContain("Contacts CRM");
  });

  it("unknown method returns error", async () => {
    const body = await rpc("nonexistent/method");
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32601);
  });
});

// ── Tools ─────────────────────────────────────────────────────

describe("tools", () => {
  it("tools/list returns all tools", async () => {
    const body = await rpc("tools/list");
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_contacts");
    expect(names).toContain("get_contact");
    expect(names).toContain("create_contact");
  });

  it("create + get + list round trip", async () => {
    const id = `test-${Date.now()}`;

    // Create
    const create = await rpc("tools/call", {
      name: "create_contact",
      arguments: { id, name: "Test User", email: "test@example.com", company: "Acme" },
    });
    expect(create.result.isError).toBeUndefined();
    expect(create.result.content[0].text).toContain(id);

    // Get
    const get = await rpc("tools/call", {
      name: "get_contact",
      arguments: { id },
    });
    expect(get.result.isError).toBeUndefined();
    const data = JSON.parse(get.result.content[0].text);
    expect(data.name).toBe("Test User");
    expect(data.email).toBe("test@example.com");
    expect(data.company).toBe("Acme");
  });

  it("list_contacts returns an array", async () => {
    const body = await rpc("tools/call", {
      name: "list_contacts",
      arguments: {},
    });
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toHaveLength(1);
    const items = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(items)).toBe(true);
  });

  it("get_contact returns isError for missing contact", async () => {
    const body = await rpc("tools/call", {
      name: "get_contact",
      arguments: { id: "nonexistent-id-999" },
    });
    expect(body.result.isError).toBe(true);
  });

  it("unknown tool returns error", async () => {
    const body = await rpc("tools/call", {
      name: "no_such_tool",
      arguments: {},
    });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });
});

// ── Resources ─────────────────────────────────────────────────

describe("resources", () => {
  it("resources/list returns static resources", async () => {
    const body = await rpc("resources/list");
    const uris = body.result.resources.map((r: any) => r.uri);
    expect(uris).toContain("resource://schema");
  });

  it("resources/templates/list returns templates", async () => {
    const body = await rpc("resources/templates/list");
    const templates = body.result.resourceTemplates.map((r: any) => r.uriTemplate);
    expect(templates).toContain("resource://contacts/{id}");
  });

  it("resources/read returns schema", async () => {
    const body = await rpc("resources/read", { uri: "resource://schema" });
    expect(body.result.contents).toHaveLength(1);
    const schema = JSON.parse(body.result.contents[0].text);
    expect(schema).toHaveProperty("pk");
    expect(schema).toHaveProperty("data");
  });

  it("resources/read with template URI", async () => {
    const id = `res-test-${Date.now()}`;
    await rpc("tools/call", {
      name: "create_contact",
      arguments: { id, name: "Resource Test", email: "res@test.com" },
    });

    const body = await rpc("resources/read", { uri: `resource://contacts/${id}` });
    expect(body.result.contents).toHaveLength(1);
    const data = JSON.parse(body.result.contents[0].text);
    expect(data.name).toBe("Resource Test");
  });

  it("resources/read returns error for unknown URI", async () => {
    const body = await rpc("resources/read", { uri: "resource://unknown/path" });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32002);
  });
});

// ── Prompts ───────────────────────────────────────────────────

describe("prompts", () => {
  it("prompts/list returns available prompts", async () => {
    const body = await rpc("prompts/list");
    const names = body.result.prompts.map((p: any) => p.name);
    expect(names).toContain("summarize_contact");
  });

  it("prompts/get returns messages with arguments", async () => {
    const body = await rpc("prompts/get", {
      name: "summarize_contact",
      arguments: { contactId: "test-123" },
    });
    expect(body.result.messages).toHaveLength(1);
    expect(body.result.messages[0].role).toBe("user");
    expect(body.result.messages[0].content.type).toBe("text");
    expect(body.result.messages[0].content.text).toContain("sales assistant");
  });

  it("unknown prompt returns error", async () => {
    const body = await rpc("prompts/get", { name: "nonexistent" });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });
});
