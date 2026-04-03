import { describe, it, expect, expectTypeOf } from "vitest";
import { defineMcp } from "~aws/handlers/define-mcp";
import { defineTable } from "~aws/handlers/define-table";
import type { TableClient } from "~aws/runtime/table-client";
import type { StaticFiles } from "~aws/handlers/shared";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type User = { name: string; email: string };

const usersTable = defineTable<User>().build();

// ── Builder pattern ────────────────────────────────────────────

describe("defineMcp builder", () => {

  it("minimal — single tool", () => {
    const m = defineMcp({ name: "test-server" })
      .tool({
        name: "ping",
        description: "Ping",
        input: { type: "object", properties: {}, required: [] },
      }, () => ({ content: [{ type: "text", text: "pong" }] }));

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.__spec).toEqual({ name: "test-server" });
    expect(m.tools).toBeTypeOf("function");
    expect(m.deps).toBeUndefined();
    expect(m.config).toBeUndefined();
    expect(m.setup).toBeUndefined();
    expect(m.static).toBeUndefined();
    expect(m.resources).toBeUndefined();
    expect(m.prompts).toBeUndefined();
  });

  it("preserves name and version in __spec", () => {
    const m = defineMcp({ name: "my-server", version: "2.0.0" }).build();

    expect(m.__spec.name).toBe("my-server");
    expect(m.__spec.version).toBe("2.0.0");
  });

  it("deps are stored as factory function", () => {
    const m = defineMcp({ name: "test" })
      .deps(() => ({ usersTable }))
      .build();

    expect(m.deps).toBeTypeOf("function");
  });

  it("config stores resolved secret refs", () => {
    const m = defineMcp({ name: "test" })
      .config(({ defineSecret }) => ({
        apiKey: defineSecret({ key: "api-key" }),
      }))
      .build();

    expect(m.config).toBeDefined();
    expect((m.config as any).apiKey.__brand).toBe("effortless-secret");
  });

  it("include accumulates static globs", () => {
    const m = defineMcp({ name: "test" })
      .include("templates/*.html")
      .include("assets/*.css")
      .build();

    expect(m.static).toEqual(["templates/*.html", "assets/*.css"]);
  });

  it("setup stores factory function", () => {
    const setupFn = () => ({ runtime: "test" });
    const m = defineMcp({ name: "test" })
      .setup(setupFn)
      .build();

    expect(m.setup).toBe(setupFn);
  });

  it("setup with lambda options stores both", () => {
    const m = defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" }), { memory: 256 })
      .build();

    expect(m.setup).toBeTypeOf("function");
    expect(m.__spec.lambda?.memory).toBe(256);
  });

  it("setup with lambda-only options (no factory)", () => {
    const m = defineMcp({ name: "test" })
      .setup({ memory: 128, timeout: "30s" })
      .build();

    expect(m.__spec.lambda?.memory).toBe(128);
    expect(m.__spec.lambda?.timeout).toBe("30s");
    expect(m.setup).toBeUndefined();
  });

  it("onError and onCleanup are stored", () => {
    const onErr = () => {};
    const onClean = () => {};
    const m = defineMcp({ name: "test" })
      .onError(onErr)
      .onCleanup(onClean)
      .build();

    expect(m.onError).toBe(onErr);
    expect(m.onCleanup).toBe(onClean);
  });

  it(".build() without entries produces handler with no tools/resources/prompts", () => {
    const m = defineMcp({ name: "empty" }).build();

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.__spec.name).toBe("empty");
    expect(m.tools).toBeUndefined();
    expect(m.resources).toBeUndefined();
    expect(m.prompts).toBeUndefined();
  });
});

// ── Singular .tool() / .resource() / .prompt() ───────────────

describe("defineMcp singular methods", () => {

  it("single .tool() returns branded handler", () => {
    const m = defineMcp({ name: "test" })
      .tool({
        name: "ping",
        description: "Ping",
        input: { type: "object", properties: {} },
      }, () => ({ content: [{ type: "text", text: "pong" }] }));

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.tools).toBeTypeOf("function");
    const tools = (m.tools as any)();
    expect(Object.keys(tools)).toEqual(["ping"]);
    expect(tools.ping.description).toBe("Ping");
  });

  it("multiple .tool() calls chain and accumulate", () => {
    const m = defineMcp({ name: "test" })
      .tool({
        name: "a",
        description: "A",
        input: { type: "object", properties: {} },
      }, () => ({ content: [{ type: "text", text: "a" }] }))
      .tool({
        name: "b",
        description: "B",
        input: { type: "object", properties: {} },
      }, () => ({ content: [{ type: "text", text: "b" }] }));

    const tools = (m.tools as any)();
    expect(Object.keys(tools).sort()).toEqual(["a", "b"]);
  });

  it("single .resource() returns branded handler with resource", () => {
    const m = defineMcp({ name: "test" })
      .resource({
        uri: "data://config",
        name: "Config",
      }, (_params) => ({ uri: "data://config", text: "{}" }));

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.resources).toBeTypeOf("function");
    const resources = (m.resources as any)();
    expect(resources["data://config"].name).toBe("Config");
  });

  it("multiple .resource() calls chain and accumulate", () => {
    const m = defineMcp({ name: "test" })
      .resource({
        uri: "data://a",
        name: "A",
      }, (_params) => ({ uri: "data://a", text: "a" }))
      .resource({
        uri: "data://b",
        name: "B",
      }, (_params) => ({ uri: "data://b", text: "b" }));

    const resources = (m.resources as any)();
    expect(Object.keys(resources).sort()).toEqual(["data://a", "data://b"]);
  });

  it("single .prompt() returns branded handler with prompt", () => {
    const m = defineMcp({ name: "test" })
      .prompt({
        name: "greet",
        description: "Greeting",
      }, (args) => `Hello ${args.name}`);

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.prompts).toBeTypeOf("function");
    const prompts = (m.prompts as any)();
    expect(prompts.greet.description).toBe("Greeting");
  });

  it("multiple .prompt() calls chain and accumulate", () => {
    const m = defineMcp({ name: "test" })
      .prompt({ name: "a" }, () => "a")
      .prompt({ name: "b" }, () => "b");

    const prompts = (m.prompts as any)();
    expect(Object.keys(prompts).sort()).toEqual(["a", "b"]);
  });

  it("full chain — deps + config + include + setup + tool + resource + prompt", () => {
    const m = defineMcp({ name: "full", version: "1.0.0" })
      .deps(() => ({ usersTable }))
      .config(({ defineSecret }) => ({ key: defineSecret() }))
      .include("tpl/*.ejs")
      .setup(({ deps, config, files }) => ({
        users: deps.usersTable,
        key: config.key,
        tpl: files,
      }))
      .onError(({ error }) => console.error(error))
      .resource({
        uri: "resource://users",
        name: "All users",
      }, async (_params) => ({ uri: "resource://users", text: "[]" }))
      .prompt({
        name: "lookup",
        description: "Look up a user",
        args: [{ name: "userId", required: true }],
      }, async (args) => `Find user ${args.userId}`)
      .tool({
        name: "get_user",
        description: "Get user",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      }, async () => ({ content: [{ type: "text", text: "ok" }] }));

    expect(m.__brand).toBe("effortless-mcp");
    expect(m.__spec.name).toBe("full");
    expect(m.__spec.version).toBe("1.0.0");
    expect(m.deps).toBeTypeOf("function");
    expect(m.config).toBeDefined();
    expect(m.static).toEqual(["tpl/*.ejs"]);
    expect(m.setup).toBeTypeOf("function");
    expect(m.onError).toBeTypeOf("function");
    expect(m.resources).toBeTypeOf("function");
    expect(m.prompts).toBeTypeOf("function");
    expect(m.tools).toBeTypeOf("function");

    const tools = (m.tools as any)();
    expect(Object.keys(tools)).toEqual(["get_user"]);
    const resources = (m.resources as any)();
    expect(Object.keys(resources)).toEqual(["resource://users"]);
    const prompts = (m.prompts as any)();
    expect(Object.keys(prompts)).toEqual(["lookup"]);
  });
});

// ── Type inference ─────────────────────────────────────────────

describe("defineMcp type inference", () => {

  it(".tool() handler receives typed ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .tool({
        name: "t",
        description: "T",
        input: { type: "object", properties: {} },
      }, (_input, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      });
  });

  it(".resource() handler receives typed ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .resource({
        uri: "data://x",
        name: "X",
      }, (_params, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return { uri: "data://x", text: "ok" };
      });
  });

  it(".prompt() handler receives typed ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .prompt({ name: "p" }, (_args, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return "ok";
      });
  });

  it("deps → typed in setup → typed in tool handler", () => {
    defineMcp({ name: "test" })
      .deps(() => ({ usersTable }))
      .setup(({ deps }) => {
        type _users = Expect<Equal<typeof deps.usersTable, TableClient<User>>>;
        return { users: deps.usersTable };
      })
      .tool({
        name: "t",
        description: "T",
        input: { type: "object", properties: {} },
      }, (_input, { users }) => {
        type _users = Expect<Equal<typeof users, TableClient<User>>>;
        return { content: [{ type: "text", text: "ok" }] };
      });
  });

  it("config → typed in setup", () => {
    defineMcp({ name: "test" })
      .config(({ defineSecret }) => ({
        dbUrl: defineSecret({ key: "db-url" }),
        retries: defineSecret<number>({ key: "retries", transform: Number }),
      }))
      .setup(({ config }) => {
        type _url = Expect<Equal<typeof config.dbUrl, string>>;
        type _retries = Expect<Equal<typeof config.retries, number>>;
        return {};
      })
      .build();
  });

  it("include → files available in setup", () => {
    defineMcp({ name: "test" })
      .include("templates/*.html")
      .setup(({ files }) => {
        type _files = Expect<Equal<typeof files, StaticFiles>>;
        return { tpl: files };
      })
      .tool({
        name: "t",
        description: "T",
        input: { type: "object", properties: {} },
      }, (_input, { tpl }) => {
        type _tpl = Expect<Equal<typeof tpl, StaticFiles>>;
        return { content: [{ type: "text", text: "ok" }] };
      });
  });

  it(".tool() on McpEntries preserves ctx type across chain", () => {
    const m = defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .tool({
        name: "a",
        description: "A",
        input: { type: "object", properties: {} },
      }, (_input, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      })
      .tool({
        name: "b",
        description: "B",
        input: { type: "object", properties: {} },
      }, (_input, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      });

    expectTypeOf(m.__brand).toEqualTypeOf<"effortless-mcp">();
  });

  it("brand is effortless-mcp", () => {
    const m = defineMcp({ name: "test" }).build();
    expectTypeOf(m.__brand).toEqualTypeOf<"effortless-mcp">();
  });
});

// ── Typed schema support ──────────────────────────────────────

/** Minimal StandardJSONSchemaV1 mock — avoids importing Zod at test time */
const mockSchema = <T>(output: T) => ({
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as T }),
    jsonSchema: {
      input: () => ({ type: "object", properties: {} }),
      output: () => ({ type: "object", properties: {} }),
    },
    types: {} as { input: T; output: T },
  },
});

describe("defineMcp typed schema", () => {

  it(".tool() with StandardJSONSchemaV1 mock infers handler input type", () => {
    const schema = mockSchema<{ name: string; age: number }>({ name: "", age: 0 });

    defineMcp({ name: "test" })
      .tool({
        name: "create_user",
        description: "Create user",
        input: schema,
      }, (input) => {
        type _input = Expect<Equal<typeof input, { name: string; age: number }>>;
        return { content: [{ type: "text", text: "ok" }] };
      });
  });

  it(".tool() with raw JSON Schema still works (backwards compat)", () => {
    const m = defineMcp({ name: "test" })
      .tool({
        name: "ping",
        description: "Ping",
        input: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      }, (input) => {
        return { content: [{ type: "text", text: input.message }] };
      });

    expect(m.__brand).toBe("effortless-mcp");
    const tools = (m.tools as any)();
    expect(tools.ping.description).toBe("Ping");
    expect(tools.ping.input.type).toBe("object");
  });

  it("typed schema + setup ctx both work together", () => {
    const schema = mockSchema<{ query: string }>({ query: "" });

    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .tool({
        name: "search",
        description: "Search",
        input: schema,
      }, (input, { db }) => {
        type _input = Expect<Equal<typeof input, { query: string }>>;
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      });
  });

  it("chaining typed and raw tools on McpEntries preserves types", () => {
    const schema = mockSchema<{ id: number }>({ id: 0 });

    const m = defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .tool({
        name: "typed_tool",
        description: "Typed",
        input: schema,
      }, (input, { db }) => {
        type _input = Expect<Equal<typeof input, { id: number }>>;
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      })
      .tool({
        name: "raw_tool",
        description: "Raw",
        input: { type: "object", properties: { name: { type: "string" } } },
      }, (_input, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return { content: [{ type: "text", text: "ok" }] };
      });

    expectTypeOf(m.__brand).toEqualTypeOf<"effortless-mcp">();
  });

  it("tools factory returns typed tool defs with ~standard on input", () => {
    const schema = mockSchema<{ x: number }>({ x: 0 });

    const m = defineMcp({ name: "test" })
      .tool({
        name: "typed_tool",
        description: "Typed tool",
        input: schema,
      }, () => ({ content: [{ type: "text", text: "ok" }] }));

    const tools = (m.tools as any)();
    expect(tools.typed_tool).toBeDefined();
    expect(tools.typed_tool.input["~standard"]).toBeDefined();
    expect(tools.typed_tool.input["~standard"].vendor).toBe("test");
    expect(tools.typed_tool.input["~standard"].version).toBe(1);
    expect(typeof tools.typed_tool.input["~standard"].jsonSchema.input).toBe("function");
  });

  it("tools factory returns raw tool defs without ~standard on input", () => {
    const m = defineMcp({ name: "test" })
      .tool({
        name: "raw_tool",
        description: "Raw tool",
        input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      }, () => ({ content: [{ type: "text", text: "ok" }] }));

    const tools = (m.tools as any)();
    expect(tools.raw_tool).toBeDefined();
    expect(tools.raw_tool.input["~standard"]).toBeUndefined();
    expect(tools.raw_tool.input.type).toBe("object");
    expect(tools.raw_tool.input.properties).toEqual({ name: { type: "string" } });
  });
});
