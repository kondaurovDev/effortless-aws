import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock handler-utils
const mockPatchConsole = vi.fn()
const mockRestoreConsole = vi.fn()
const mockLogExecution = vi.fn()
const mockLogError = vi.fn()
const mockCommonArgs = vi.fn()

vi.mock("~aws/runtime/handler-utils", () => ({
  createHandlerRuntime: () => ({
    handlerName: "test-mcp",
    patchConsole: mockPatchConsole,
    restoreConsole: mockRestoreConsole,
    logExecution: mockLogExecution,
    logError: mockLogError,
    commonArgs: mockCommonArgs,
  }),
}))

import { wrapMcp } from "~aws/runtime/wrap-mcp"

// ── Helpers ──────────────────────────────────────────────────────

const makeHandler = (overrides: Record<string, any> = {}) => ({
  __brand: "effortless-mcp" as const,
  __spec: { name: "test-server", version: "2.0.0", lambda: {} },
  tools: () => ({}),
  ...overrides,
})

const postEvent = (body: unknown, extra: Record<string, any> = {}) => ({
  requestContext: { http: { method: "POST", path: "/" } },
  headers: {},
  body: JSON.stringify(body),
  isBase64Encoded: false,
  ...extra,
})

const rpcRequest = (method: string, params?: Record<string, unknown>, id: number | string = 1) =>
  postEvent({ jsonrpc: "2.0", id, method, params })

const getEvent = () => ({
  requestContext: { http: { method: "GET", path: "/" } },
  headers: {},
})

// ── Tests ────────────────────────────────────────────────────────

describe("wrapMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCommonArgs.mockResolvedValue({ ctx: {} })
  })

  // ── GET health check ──

  describe("GET health check", () => {
    it("should return server info on GET", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(getEvent())

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.result).toEqual({
        name: "test-server",
        version: "2.0.0",
        protocol: "mcp",
      })
      expect(body.jsonrpc).toBe("2.0")
    })

    it("should default version to 1.0.0 when not specified", async () => {
      const handler = wrapMcp(makeHandler({
        __spec: { name: "minimal", lambda: {} },
      }) as any)
      const res = await handler(getEvent())

      const body = JSON.parse(res.body)
      expect(body.result.version).toBe("1.0.0")
    })
  })

  // ── Method Not Allowed ──

  describe("unsupported HTTP methods", () => {
    it("should return 405 for PUT", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler({
        requestContext: { http: { method: "PUT", path: "/" } },
        headers: {},
      })

      expect(res.statusCode).toBe(405)
      expect(JSON.parse(res.body).error).toBe("Method not allowed")
    })

    it("should return 405 for DELETE", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler({
        requestContext: { http: { method: "DELETE", path: "/" } },
        headers: {},
      })

      expect(res.statusCode).toBe(405)
    })
  })

  // ── Base64-encoded body ──

  describe("base64-encoded body", () => {
    it("should decode base64-encoded POST body", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          ping: {
            description: "Ping",
            input: { type: "object", properties: {}, required: [] },
            handler: () => ({ content: [{ type: "text", text: "pong" }] }),
          },
        }),
      }) as any)

      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      const res = await handler({
        requestContext: { http: { method: "POST", path: "/" } },
        headers: {},
        body: Buffer.from(body).toString("base64"),
        isBase64Encoded: true,
      })

      expect(res.statusCode).toBe(200)
      const parsed = JSON.parse(res.body)
      expect(parsed.result.tools).toHaveLength(1)
      expect(parsed.result.tools[0].name).toBe("ping")
    })
  })

  // ── Malformed JSON-RPC ──

  describe("malformed JSON-RPC requests", () => {
    it("should reject missing body", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler({
        requestContext: { http: { method: "POST", path: "/" } },
        headers: {},
        body: undefined,
        isBase64Encoded: false,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32600)
      expect(body.error.message).toBe("Invalid JSON-RPC request")
    })

    it("should reject invalid JSON", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler({
        requestContext: { http: { method: "POST", path: "/" } },
        headers: {},
        body: "not json",
        isBase64Encoded: false,
      })

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32600)
    })

    it("should reject missing jsonrpc field", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(postEvent({ id: 1, method: "ping" }))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32600)
    })

    it("should reject missing method field", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(postEvent({ jsonrpc: "2.0", id: 1 }))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32600)
    })
  })

  // ── Notifications ──

  describe("notifications", () => {
    it("should accept notifications/initialized", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("notifications/initialized"))

      const body = JSON.parse(res.body)
      expect(body.result).toEqual({})
    })

    it("should accept notifications/cancelled", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("notifications/cancelled"))

      const body = JSON.parse(res.body)
      expect(body.result).toEqual({})
    })
  })

  // ── Initialize ──

  describe("initialize", () => {
    it("should return protocol version and capabilities", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          myTool: { description: "A tool", input: { type: "object", properties: {} }, handler: () => ({ content: [] }) },
        }),
        resources: () => ({
          "resource://data": { name: "Data", handler: () => ({ uri: "resource://data", text: "hi" }) },
        }),
        prompts: () => ({
          greet: { description: "Greet", handler: () => ({ messages: [] }) },
        }),
      }) as any)

      const res = await handler(rpcRequest("initialize"))
      const body = JSON.parse(res.body)

      expect(body.result.protocolVersion).toBe("2025-03-26")
      expect(body.result.capabilities).toEqual({
        tools: {},
        resources: {},
        prompts: {},
      })
      expect(body.result.serverInfo).toBeDefined()
    })

    it("should omit capabilities for empty registries", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({}),
        resources: undefined,
        prompts: undefined,
      }) as any)

      const res = await handler(rpcRequest("initialize"))
      const body = JSON.parse(res.body)

      expect(body.result.capabilities).toEqual({})
    })

    it("should include instructions when provided", async () => {
      const handler = wrapMcp(makeHandler({
        __spec: { name: "test", instructions: "You are a helpful assistant.", lambda: {} },
      }) as any)

      const res = await handler(rpcRequest("initialize"))
      const body = JSON.parse(res.body)

      expect(body.result.instructions).toBe("You are a helpful assistant.")
    })

    it("should omit instructions when not provided", async () => {
      const handler = wrapMcp(makeHandler() as any)

      const res = await handler(rpcRequest("initialize"))
      const body = JSON.parse(res.body)

      expect(body.result.instructions).toBeUndefined()
    })
  })

  // ── Ping ──

  describe("ping", () => {
    it("should respond with empty result", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("ping"))

      const body = JSON.parse(res.body)
      expect(body.jsonrpc).toBe("2.0")
      expect(body.id).toBe(1)
      expect(body.result).toEqual({})
    })
  })

  // ── Tools ──

  describe("tools/list", () => {
    it("should list all registered tools", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          add: {
            description: "Add numbers",
            input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
            handler: () => ({ content: [{ type: "text", text: "3" }] }),
          },
          greet: {
            description: "Greet someone",
            input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            handler: () => ({ content: [{ type: "text", text: "hello" }] }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("tools/list"))
      const body = JSON.parse(res.body)

      expect(body.result.tools).toHaveLength(2)
      expect(body.result.tools[0].name).toBe("add")
      expect(body.result.tools[0].description).toBe("Add numbers")
      expect(body.result.tools[0].inputSchema).toEqual({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      })
    })
  })

  describe("tools/call", () => {
    it("should call tool handler and return result", async () => {
      const toolHandler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "42" }],
      })
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          compute: {
            description: "Compute",
            input: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
            handler: toolHandler,
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("tools/call", { name: "compute", arguments: { x: 7 } }))
      const body = JSON.parse(res.body)

      expect(body.result.content[0].text).toBe("42")
      expect(toolHandler).toHaveBeenCalledWith({ x: 7 }, expect.any(Object))
    })

    it("should return error for unknown tool", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("tools/call", { name: "nonexistent" }))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toContain("nonexistent")
    })

    it("should return error for missing tool name", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("tools/call", {}))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32602)
    })

    it("should return isError result when tool handler throws", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          fail: {
            description: "Fails",
            input: { type: "object", properties: {} },
            handler: () => { throw new Error("tool broke"); },
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("tools/call", { name: "fail" }))
      const body = JSON.parse(res.body)

      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toBe("tool broke")
    })

    it("should stringify non-Error throws in tool handler", async () => {
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          fail: {
            description: "Fails",
            input: { type: "object", properties: {} },
            handler: () => { throw "string error"; },
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("tools/call", { name: "fail" }))
      const body = JSON.parse(res.body)

      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toBe("string error")
    })

    it("should default arguments to empty object when not provided", async () => {
      const toolHandler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      })
      const handler = wrapMcp(makeHandler({
        tools: () => ({
          noargs: {
            description: "No args",
            input: { type: "object", properties: {} },
            handler: toolHandler,
          },
        }),
      }) as any)

      await handler(rpcRequest("tools/call", { name: "noargs" }))
      expect(toolHandler).toHaveBeenCalledWith({}, expect.any(Object))
    })
  })

  // ── Resources ──

  describe("resources/list", () => {
    it("should list static resources only (not templates)", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://schema": {
            name: "Schema",
            description: "The schema",
            mimeType: "application/json",
            handler: () => ({ uri: "resource://schema", text: "{}" }),
          },
          "resource://users/{userId}": {
            name: "User",
            description: "A user by ID",
            handler: (_params: any) => ({ uri: "resource://users/1", text: "{}" }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/list"))
      const body = JSON.parse(res.body)

      expect(body.result.resources).toHaveLength(1)
      expect(body.result.resources[0].uri).toBe("resource://schema")
      expect(body.result.resources[0].name).toBe("Schema")
      expect(body.result.resources[0].description).toBe("The schema")
      expect(body.result.resources[0].mimeType).toBe("application/json")
    })

    it("should omit optional fields when not provided", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://data": {
            name: "Data",
            handler: () => ({ uri: "resource://data", text: "hi" }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/list"))
      const body = JSON.parse(res.body)

      expect(body.result.resources[0]).toEqual({ uri: "resource://data", name: "Data" })
    })
  })

  describe("resources/templates/list", () => {
    it("should list template resources only", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://schema": {
            name: "Schema",
            handler: () => ({ uri: "resource://schema", text: "{}" }),
          },
          "resource://users/{userId}": {
            name: "User",
            description: "A user by ID",
            handler: (_params: any) => ({ uri: "resource://users/1", text: "{}" }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/templates/list"))
      const body = JSON.parse(res.body)

      expect(body.result.resourceTemplates).toHaveLength(1)
      expect(body.result.resourceTemplates[0].uriTemplate).toBe("resource://users/{userId}")
      expect(body.result.resourceTemplates[0].name).toBe("User")
    })
  })

  describe("resources/read", () => {
    it("should read a static resource", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://schema": {
            name: "Schema",
            handler: () => ({ uri: "resource://schema", text: '{"ok":true}' }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://schema" }))
      const body = JSON.parse(res.body)

      expect(body.result.contents).toHaveLength(1)
      expect(body.result.contents[0].uri).toBe("resource://schema")
      expect(body.result.contents[0].text).toBe('{"ok":true}')
    })

    it("should read a template resource with params", async () => {
      const resourceHandler = vi.fn().mockResolvedValue({
        uri: "resource://users/42",
        text: '{"id":"42"}',
      })
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://users/{userId}": {
            name: "User",
            handler: resourceHandler,
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://users/42" }))
      const body = JSON.parse(res.body)

      expect(body.result.contents).toHaveLength(1)
      expect(body.result.contents[0].text).toBe('{"id":"42"}')
      expect(resourceHandler).toHaveBeenCalledWith({ userId: "42" }, expect.any(Object))
    })

    it("should handle multi-segment template params", async () => {
      const resourceHandler = vi.fn().mockResolvedValue({
        uri: "resource://org/acme/repo/widgets",
        text: "data",
      })
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://org/{orgName}/repo/{repoName}": {
            name: "Repo",
            handler: resourceHandler,
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://org/acme/repo/widgets" }))
      const body = JSON.parse(res.body)

      expect(body.result.contents).toHaveLength(1)
      expect(resourceHandler).toHaveBeenCalledWith(
        { orgName: "acme", repoName: "widgets" },
        expect.any(Object),
      )
    })

    it("should handle resource handler returning an array", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://multi": {
            name: "Multi",
            handler: () => [
              { uri: "resource://multi/a", text: "a" },
              { uri: "resource://multi/b", text: "b" },
            ],
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://multi" }))
      const body = JSON.parse(res.body)

      expect(body.result.contents).toHaveLength(2)
    })

    it("should return error for missing uri parameter", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://data": { name: "Data", handler: () => ({ uri: "resource://data", text: "" }) },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", {}))
      const body = JSON.parse(res.body)

      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toBe("Missing uri parameter")
    })

    it("should return error for unknown resource", async () => {
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://data": { name: "Data", handler: () => ({ uri: "resource://data", text: "" }) },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://unknown" }))
      const body = JSON.parse(res.body)

      expect(body.error.code).toBe(-32002)
      expect(body.error.message).toBe("Resource not found")
      expect(body.error.data).toEqual({ uri: "resource://unknown" })
    })

    it("should prefer static resource over template when URI matches exactly", async () => {
      const staticHandler = vi.fn().mockResolvedValue({ uri: "resource://static", text: "static" })
      const templateHandler = vi.fn().mockResolvedValue({ uri: "resource://static", text: "template" })
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://static": {
            name: "Static",
            handler: staticHandler,
          },
          "resource://{any}": {
            name: "Template",
            handler: templateHandler,
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("resources/read", { uri: "resource://static" }))
      const body = JSON.parse(res.body)

      expect(body.result.contents[0].text).toBe("static")
      expect(staticHandler).toHaveBeenCalled()
      expect(templateHandler).not.toHaveBeenCalled()
    })

    it("should URL-decode template parameters", async () => {
      const resourceHandler = vi.fn().mockResolvedValue({ uri: "x", text: "ok" })
      const handler = wrapMcp(makeHandler({
        resources: () => ({
          "resource://files/{path}": {
            name: "File",
            handler: resourceHandler,
          },
        }),
      }) as any)

      await handler(rpcRequest("resources/read", { uri: "resource://files/hello%20world" }))
      expect(resourceHandler).toHaveBeenCalledWith({ path: "hello world" }, expect.any(Object))
    })
  })

  // ── Prompts ──

  describe("prompts/list", () => {
    it("should list all registered prompts", async () => {
      const handler = wrapMcp(makeHandler({
        prompts: () => ({
          greet: {
            description: "Greet someone",
            arguments: [{ name: "name", required: true }],
            handler: () => ({ messages: [] }),
          },
          summarize: {
            description: "Summarize text",
            handler: () => ({ messages: [] }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("prompts/list"))
      const body = JSON.parse(res.body)

      expect(body.result.prompts).toHaveLength(2)
      expect(body.result.prompts[0].name).toBe("greet")
      expect(body.result.prompts[0].description).toBe("Greet someone")
      expect(body.result.prompts[0].arguments).toEqual([{ name: "name", required: true }])
      expect(body.result.prompts[1].name).toBe("summarize")
    })

    it("should omit optional fields when not provided", async () => {
      const handler = wrapMcp(makeHandler({
        prompts: () => ({
          basic: {
            handler: () => ({ messages: [] }),
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("prompts/list"))
      const body = JSON.parse(res.body)

      expect(body.result.prompts[0]).toEqual({ name: "basic" })
    })
  })

  describe("prompts/get", () => {
    it("should call prompt handler and return result", async () => {
      const promptHandler = vi.fn().mockResolvedValue({
        messages: [{ role: "user", content: { type: "text", text: "Hello Alice" } }],
      })
      const handler = wrapMcp(makeHandler({
        prompts: () => ({
          greet: {
            description: "Greet",
            arguments: [{ name: "name", required: true }],
            handler: promptHandler,
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("prompts/get", { name: "greet", arguments: { name: "Alice" } }))
      const body = JSON.parse(res.body)

      expect(body.result.messages[0].content.text).toBe("Hello Alice")
      expect(promptHandler).toHaveBeenCalledWith({ name: "Alice" }, expect.any(Object))
    })

    it("should return error for unknown prompt", async () => {
      const handler = wrapMcp(makeHandler({
        prompts: () => ({}),
      }) as any)

      const res = await handler(rpcRequest("prompts/get", { name: "nonexistent" }))
      const body = JSON.parse(res.body)

      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toContain("nonexistent")
    })

    it("should return error when prompt handler throws", async () => {
      const handler = wrapMcp(makeHandler({
        prompts: () => ({
          broken: {
            description: "Broken",
            handler: () => { throw new Error("prompt broke"); },
          },
        }),
      }) as any)

      const res = await handler(rpcRequest("prompts/get", { name: "broken" }))
      const body = JSON.parse(res.body)

      expect(body.error.code).toBe(-32603)
      expect(body.error.message).toBe("prompt broke")
    })
  })

  // ── Unknown method ──

  describe("unknown method", () => {
    it("should return method not found error", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler(rpcRequest("foo/bar"))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32601)
      expect(body.error.message).toContain("foo/bar")
    })
  })

  // ── onError callback ──

  describe("onError", () => {
    it("should invoke onError when an unhandled exception occurs", async () => {
      const onError = vi.fn()
      mockCommonArgs.mockRejectedValue(new Error("ctx exploded"))

      const handler = wrapMcp(makeHandler({ onError }) as any)
      const res = await handler(rpcRequest("tools/list"))

      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32603)
      expect(body.error.message).toBe("Internal server error")
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.any(Error),
        toolName: "unknown",
      }))
    })

    it("should not throw if onError itself throws", async () => {
      const onError = vi.fn().mockRejectedValue(new Error("onError broke"))
      mockCommonArgs.mockRejectedValue(new Error("ctx exploded"))

      const handler = wrapMcp(makeHandler({ onError }) as any)
      const res = await handler(rpcRequest("tools/list"))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.error.code).toBe(-32603)
    })
  })

  // ── onCleanup ──

  describe("onCleanup", () => {
    it("should call onCleanup after successful request", async () => {
      const onCleanup = vi.fn()
      const handler = wrapMcp(makeHandler({ onCleanup }) as any)

      await handler(rpcRequest("ping"))

      expect(onCleanup).toHaveBeenCalled()
    })

    it("should call onCleanup after error", async () => {
      const onCleanup = vi.fn()
      mockCommonArgs.mockRejectedValue(new Error("fail"))

      const handler = wrapMcp(makeHandler({ onCleanup }) as any)
      await handler(rpcRequest("ping"))

      expect(onCleanup).toHaveBeenCalled()
    })

    it("should not throw when onCleanup itself throws", async () => {
      const onCleanup = vi.fn().mockRejectedValue(new Error("cleanup failed"))
      const handler = wrapMcp(makeHandler({ onCleanup }) as any)

      const res = await handler(rpcRequest("ping"))

      expect(res.statusCode).toBe(200)
    })
  })

  // ── Console patching ──

  describe("console patching", () => {
    it("should patch and restore console", async () => {
      const handler = wrapMcp(makeHandler() as any)
      await handler(rpcRequest("ping"))

      expect(mockPatchConsole).toHaveBeenCalled()
      expect(mockRestoreConsole).toHaveBeenCalled()
    })

    it("should restore console even on error", async () => {
      mockCommonArgs.mockRejectedValue(new Error("boom"))
      const handler = wrapMcp(makeHandler() as any)

      await handler(rpcRequest("ping"))

      expect(mockRestoreConsole).toHaveBeenCalled()
    })
  })

  // ── Logging ──

  describe("logging", () => {
    it("should log execution for successful requests", async () => {
      const handler = wrapMcp(makeHandler() as any)
      await handler(rpcRequest("ping"))

      expect(mockLogExecution).toHaveBeenCalled()
    })

    it("should log error for unhandled exceptions", async () => {
      mockCommonArgs.mockRejectedValue(new Error("fail"))
      const handler = wrapMcp(makeHandler() as any)

      await handler(rpcRequest("ping"))

      expect(mockLogError).toHaveBeenCalled()
    })
  })

  // ── Default method fallback ──

  describe("default HTTP method", () => {
    it("should default to GET when requestContext is missing", async () => {
      const handler = wrapMcp(makeHandler() as any)
      const res = await handler({})

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.result.protocol).toBe("mcp")
    })
  })
})
