import { describe, it, expectTypeOf } from "vitest";
import { defineHttp } from "~/handlers/define-http";
import { defineTable } from "~/handlers/define-table";
import { param } from "~/deploy/shared";
import type { HttpRequest } from "~/handlers/define-http";
import type { TableRecord } from "~/handlers/define-table";
import type { TableClient } from "~/runtime/table-client";
import type { TableItem } from "~/handlers/handler-options";
import type { StaticFiles } from "~/handlers/shared";

// ── Type-level equality assertion (works with tsc --noEmit) ──

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ── Fixtures ──────────────────────────────────────────────────

type User = { name: string; email: string };

const usersTable = defineTable<User>({});

// ── defineHttp ────────────────────────────────────────────────

describe("defineHttp type inference", () => {

  it("minimal handler — only req is present", () => {
    defineHttp({
      method: "GET",
      path: "/hello",
      onRequest: async (args) => {
        type _req = Expect<Equal<typeof args.req, HttpRequest>>;
        // @ts-expect-error — no data without schema
        args.data;
        // @ts-expect-error — no ctx without setup
        args.ctx;
        // @ts-expect-error — no deps without deps
        args.deps;
        // @ts-expect-error — no config without config
        args.config;
        // @ts-expect-error — no files without static
        args.files;
        return { status: 200 };
      },
    });
  });

  it("schema → data is inferred from return type", () => {
    defineHttp({
      method: "POST",
      path: "/users",
      schema: (input): User => input as User,
      onRequest: async (args) => {
        type _data = Expect<Equal<typeof args.data, User>>;
        return { status: 201 };
      },
    });
  });

  it("setup → ctx is inferred from return type", () => {
    defineHttp({
      method: "GET",
      path: "/test",
      setup: () => ({ db: "pg-pool" as const, ready: true }),
      onRequest: async (args) => {
        type _ctx = Expect<Equal<typeof args.ctx, { db: "pg-pool"; ready: boolean }>>;
        return { status: 200 };
      },
    });
  });

  it("async setup → ctx is inferred (unwraps Promise)", () => {
    defineHttp({
      method: "GET",
      path: "/test",
      setup: async () => ({ pool: 42 }),
      onRequest: async (args) => {
        type _ctx = Expect<Equal<typeof args.ctx, { pool: number }>>;
        return { status: 200 };
      },
    });
  });

  it("deps → deps is Record of TableClient", () => {
    defineHttp({
      method: "POST",
      path: "/users",
      deps: { usersTable },
      onRequest: async (args) => {
        type _deps = Expect<Equal<typeof args.deps.usersTable, TableClient<User>>>;
        return { status: 201 };
      },
    });
  });

  it("config → config values are inferred", () => {
    defineHttp({
      method: "GET",
      path: "/config",
      config: {
        dbUrl: param("database-url"),
        maxRetries: param("max-retries", Number),
      },
      onRequest: async (args) => {
        type _dbUrl = Expect<Equal<typeof args.config.dbUrl, string>>;
        type _retries = Expect<Equal<typeof args.config.maxRetries, number>>;
        return { status: 200 };
      },
    });
  });

  it("config + setup → setup factory receives config", () => {
    defineHttp({
      method: "GET",
      path: "/test",
      config: {
        dbUrl: param("database-url"),
      },
      setup: ({ config }) => {
        type _p = Expect<Equal<typeof config.dbUrl, string>>;
        return { pool: config.dbUrl };
      },
      onRequest: async (args) => {
        type _ctx = Expect<Equal<typeof args.ctx.pool, string>>;
        type _cfg = Expect<Equal<typeof args.config.dbUrl, string>>;
        return { status: 200 };
      },
    });
  });

  it("static → files is present", () => {
    defineHttp({
      method: "GET",
      path: "/page",
      static: ["src/templates/*.ejs"],
      onRequest: async (args) => {
        type _rs = Expect<Equal<typeof args.files, StaticFiles>>;
        return { status: 200 };
      },
    });
  });

  it("all features combined", () => {
    defineHttp({
      method: "POST",
      path: "/users",
      schema: (input): User => input as User,
      setup: () => ({ db: "pool" }),
      deps: { usersTable },
      config: { secret: param("api-secret") },
      static: ["templates/*.html"],
      onRequest: async (args) => {
        type _req = Expect<Equal<typeof args.req, HttpRequest>>;
        type _data = Expect<Equal<typeof args.data, User>>;
        type _ctx = Expect<Equal<typeof args.ctx, { db: string }>>;
        type _deps = Expect<Equal<typeof args.deps.usersTable, TableClient<User>>>;
        type _cfg = Expect<Equal<typeof args.config.secret, string>>;
        type _rs = Expect<Equal<typeof args.files, StaticFiles>>;
        return { status: 201 };
      },
    });
  });

  it("return type is HttpHandler with correct brand", () => {
    const handler = defineHttp({
      method: "GET",
      path: "/test",
      onRequest: async () => ({ status: 200 }),
    });
    expectTypeOf(handler.__brand).toEqualTypeOf<"effortless-http">();
  });

});

// ── defineTable ───────────────────────────────────────────────

describe("defineTable type inference", () => {

  it("resource-only — no onRecord/onBatch required", () => {
    const table = defineTable<User>({});
    expectTypeOf(table.__brand).toEqualTypeOf<"effortless-table">();
  });

  it("explicit generic → record.new is TableItem<User>", () => {
    defineTable<User>({
      onRecord: async (args) => {
        type _rec = Expect<Equal<typeof args.record, TableRecord<User>>>;
        type _new = Expect<Equal<typeof args.record.new, TableItem<User> | undefined>>;
        type _table = Expect<Equal<typeof args.table, TableClient<User>>>;
      },
    });
  });

  it("schema → T is inferred from schema return type", () => {
    defineTable({
      schema: (input): User => input as User,
      onRecord: async (args) => {
        type _new = Expect<Equal<typeof args.record.new, TableItem<User> | undefined>>;
        type _table = Expect<Equal<typeof args.table, TableClient<User>>>;
      },
    });
  });

  it("onRecord with setup + deps + config (via schema)", () => {
    defineTable({
      schema: (input): User => input as User,
      setup: () => ({ notifier: "sns" as const }),
      deps: { usersTable },
      config: { webhookUrl: param("webhook-url") },
      onRecord: async (args) => {
        type _ctx = Expect<Equal<typeof args.ctx, { notifier: "sns" }>>;
        type _deps = Expect<Equal<typeof args.deps.usersTable, TableClient<User>>>;
        type _cfg = Expect<Equal<typeof args.config.webhookUrl, string>>;
      },
    });
  });

  it("onBatch → receives records array", () => {
    defineTable({
      schema: (input): User => input as User,
      onBatch: async (args) => {
        type _recs = Expect<Equal<typeof args.records, TableRecord<User>[]>>;
        type _table = Expect<Equal<typeof args.table, TableClient<User>>>;
      },
    });
  });

  it("onRecord + onBatchComplete → R is inferred", () => {
    defineTable({
      schema: (input): User => input as User,
      onRecord: async (args) => {
        return { processed: args.record.eventName };
      },
      onBatchComplete: async (args) => {
        type _results = Expect<Equal<typeof args.results, { processed: "INSERT" | "MODIFY" | "REMOVE" }[]>>;
        type _failure = Expect<Equal<typeof args.failures[0]["record"], TableRecord<User>>>;
      },
    });
  });

  it("minimal onRecord — no ctx/deps/config/files", () => {
    defineTable<User>({
      onRecord: async (args) => {
        // @ts-expect-error — no ctx without setup
        args.ctx;
        // @ts-expect-error — no deps without deps
        args.deps;
        // @ts-expect-error — no config without config
        args.config;
        // @ts-expect-error — no files without static
        args.files;
      },
    });
  });

  it("static → files is present on onRecord", () => {
    defineTable({
      schema: (input): User => input as User,
      static: ["templates/*.html"],
      onRecord: async (args) => {
        type _rs = Expect<Equal<typeof args.files, StaticFiles>>;
      },
    });
  });

});

// ── param ─────────────────────────────────────────────────────

describe("param type inference", () => {

  it("default → string", () => {
    const ref = param("key");
    expectTypeOf(ref.__brand).toEqualTypeOf<"effortless-param">();
    expectTypeOf(ref.key).toEqualTypeOf<string>();
  });

  it("with transform → inferred from transform return", () => {
    const ref = param("count", Number);
    expectTypeOf(ref.transform).toEqualTypeOf<((raw: string) => number) | undefined>();
  });

  it("custom transform → inferred return type", () => {
    const ref = param("config", (raw) => JSON.parse(raw) as { port: number });
    expectTypeOf(ref).toMatchTypeOf<{ __brand: "effortless-param" }>();
  });

});
