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

  it("minimal — tools only", () => {
    const m = defineMcp({ name: "test-server" })
      .tools(() => ({
        ping: {
          description: "Ping",
          input: { type: "object", properties: {}, required: [] },
          handler: () => ({ content: [{ type: "text", text: "pong" }] }),
        },
      }));

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
    const m = defineMcp({ name: "my-server", version: "2.0.0" })
      .tools(() => ({}));

    expect(m.__spec.name).toBe("my-server");
    expect(m.__spec.version).toBe("2.0.0");
  });

  it("deps are stored as factory function", () => {
    const m = defineMcp({ name: "test" })
      .deps(() => ({ usersTable }))
      .tools(() => ({}));

    expect(m.deps).toBeTypeOf("function");
  });

  it("config stores resolved secret refs", () => {
    const m = defineMcp({ name: "test" })
      .config(({ defineSecret }) => ({
        apiKey: defineSecret({ key: "api-key" }),
      }))
      .tools(() => ({}));

    expect(m.config).toBeDefined();
    expect((m.config as any).apiKey.__brand).toBe("effortless-secret");
  });

  it("include accumulates static globs", () => {
    const m = defineMcp({ name: "test" })
      .include("templates/*.html")
      .include("assets/*.css")
      .tools(() => ({}));

    expect(m.static).toEqual(["templates/*.html", "assets/*.css"]);
  });

  it("setup stores factory function", () => {
    const setupFn = () => ({ runtime: "test" });
    const m = defineMcp({ name: "test" })
      .setup(setupFn)
      .tools(() => ({}));

    expect(m.setup).toBe(setupFn);
  });

  it("setup with lambda options stores both", () => {
    const m = defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" }), { memory: 256 })
      .tools(() => ({}));

    expect(m.setup).toBeTypeOf("function");
    expect(m.__spec.lambda?.memory).toBe(256);
  });

  it("setup with lambda-only options (no factory)", () => {
    const m = defineMcp({ name: "test" })
      .setup({ memory: 128, timeout: "30s" })
      .tools(() => ({}));

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
      .tools(() => ({}));

    expect(m.onError).toBe(onErr);
    expect(m.onCleanup).toBe(onClean);
  });

  it("resources are stored as factory function", () => {
    const m = defineMcp({ name: "test" })
      .resources(() => ({
        "resource://schema": {
          name: "Schema",
          handler: () => ({ uri: "resource://schema", text: "{}" }),
        },
      }))
      .tools(() => ({}));

    expect(m.resources).toBeTypeOf("function");
  });

  it("prompts are stored as factory function", () => {
    const m = defineMcp({ name: "test" })
      .prompts(() => ({
        greet: {
          description: "Greeting prompt",
          arguments: [{ name: "name", required: true }],
          handler: (args) => ({
            messages: [{ role: "user", content: { type: "text", text: `Hello ${args.name}` } }],
          }),
        },
      }))
      .tools(() => ({}));

    expect(m.prompts).toBeTypeOf("function");
  });

  it("full chain — deps + config + include + setup + resources + prompts + tools", () => {
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
      .resources(({ users }) => ({
        "resource://users": {
          name: "All users",
          handler: async () => ({ uri: "resource://users", text: "[]" }),
        },
      }))
      .prompts(({ users }) => ({
        lookup: {
          description: "Look up a user",
          arguments: [{ name: "userId", required: true }],
          handler: async (args) => ({
            messages: [{ role: "user", content: { type: "text", text: `Find user ${args.userId}` } }],
          }),
        },
      }))
      .tools(({ users, key, tpl }) => ({
        get_user: {
          description: "Get user",
          input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      }));

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
  });
});

// ── Type inference ─────────────────────────────────────────────

describe("defineMcp type inference", () => {

  it("tools receive ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .tools(({ db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return {};
      });
  });

  it("resources receive ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .resources(({ db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return {};
      })
      .tools(() => ({}));
  });

  it("prompts receive ctx from setup", () => {
    defineMcp({ name: "test" })
      .setup(() => ({ db: "pg" as const }))
      .prompts(({ db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
        return {};
      })
      .tools(() => ({}));
  });

  it("deps → typed in setup", () => {
    defineMcp({ name: "test" })
      .deps(() => ({ usersTable }))
      .setup(({ deps }) => {
        type _users = Expect<Equal<typeof deps.usersTable, TableClient<User>>>;
        return { users: deps.usersTable };
      })
      .tools(({ users }) => {
        type _users = Expect<Equal<typeof users, TableClient<User>>>;
        return {};
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
      .tools(() => ({}));
  });

  it("include → files available in setup", () => {
    defineMcp({ name: "test" })
      .include("templates/*.html")
      .setup(({ files }) => {
        type _files = Expect<Equal<typeof files, StaticFiles>>;
        return { tpl: files };
      })
      .tools(({ tpl }) => {
        type _tpl = Expect<Equal<typeof tpl, StaticFiles>>;
        return {};
      });
  });

  it("brand is effortless-mcp", () => {
    const m = defineMcp({ name: "test" }).tools(() => ({}));
    expectTypeOf(m.__brand).toEqualTypeOf<"effortless-mcp">();
  });
});
