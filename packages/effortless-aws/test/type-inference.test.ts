import { describe, it, expectTypeOf } from "vitest";
import { defineApi } from "~aws/handlers/define-api";
import { defineTable } from "~aws/handlers/define-table";
import { defineSecret } from "~aws/handlers/handler-options";
import type { HttpRequest } from "~aws/handlers/shared";
import type { TableRecord } from "~aws/handlers/define-table";
import type { TableClient } from "~aws/runtime/table-client";
import type { TableItem } from "~aws/handlers/handler-options";
import type { StaticFiles } from "~aws/handlers/shared";

// ── Type-level equality assertion (works with tsc --noEmit) ──

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ── Fixtures ──────────────────────────────────────────────────

type User = { name: string; email: string };

const usersTable = defineTable<User>()({});

// ── defineApi ─────────────────────────────────────────────────

describe("defineApi type inference", () => {

  it("route handler receives input arg", () => {
    defineApi()({
      basePath: "/hello",
      routes: [
        {
          path: "GET /check",
          onRequest: async ({ input }) => {
            const data = input as User;
            type _data = Expect<Equal<typeof data, User>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("route handler receives req without validate", () => {
    defineApi()({
      basePath: "/hello",
      routes: [
        {
          path: "GET /raw",
          onRequest: async ({ req }) => {
            type _req = Expect<Equal<typeof req, HttpRequest>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("setup → properties spread into route handler", () => {
    defineApi()({
      basePath: "/test",
      setup: () => ({ db: "pg-pool" as const, ready: true }),
      routes: [
        {
          path: "GET /index",
          onRequest: async ({ db, ready }) => {
            type _db = Expect<Equal<typeof db, "pg-pool">>;
            type _ready = Expect<Equal<typeof ready, boolean>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("deps → available in setup, spread into route", () => {
    defineApi()({
      basePath: "/test",
      deps: () => ({ usersTable }),
      setup: ({ deps }) => {
        type _deps = Expect<Equal<typeof deps.usersTable, TableClient<User>>>;
        return { users: deps.usersTable };
      },
      routes: [
        {
          path: "GET /index",
          onRequest: async ({ users }) => {
            type _users = Expect<Equal<typeof users, TableClient<User>>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("config → available in setup, spread into route", () => {
    defineApi()({
      basePath: "/config",
      config: ({ defineSecret }) => ({
        dbUrl: defineSecret({ key: "database-url" }),
        maxRetries: defineSecret<number>({ key: "max-retries", transform: Number }),
      }),
      setup: ({ config }) => {
        type _url = Expect<Equal<typeof config.dbUrl, string>>;
        type _retries = Expect<Equal<typeof config.maxRetries, number>>;
        return { dbUrl: config.dbUrl, maxRetries: config.maxRetries };
      },
      routes: [
        {
          path: "GET /index",
          onRequest: async ({ dbUrl }) => {
            type _url = Expect<Equal<typeof dbUrl, string>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("static → files available in setup, spread into route", () => {
    defineApi()({
      basePath: "/page",
      static: ["src/templates/*.ejs"],
      setup: ({ files }) => {
        type _files = Expect<Equal<typeof files, StaticFiles>>;
        return { tpl: files };
      },
      routes: [
        {
          path: "GET /index",
          onRequest: async ({ tpl }) => {
            type _tpl = Expect<Equal<typeof tpl, StaticFiles>>;
            return { status: 200 };
          },
        },
      ],
    });
  });

  it("setup return with reserved key 'req' causes type error", () => {
    defineApi()({
      basePath: "/test",
      // @ts-expect-error — 'req' is a reserved key
      setup: () => ({ req: "forbidden" }),
      routes: [],
    });
  });

  it("return type is ApiHandler with correct brand", () => {
    const handler = defineApi()({
      basePath: "/test",
      routes: [
        {
          path: "GET /index",
          onRequest: async () => ({ status: 200 }),
        },
      ],
    });
    expectTypeOf(handler.__brand).toEqualTypeOf<"effortless-api">();
  });

});

// ── defineTable ───────────────────────────────────────────────

describe("defineTable type inference", () => {

  it("resource-only — no onRecord required", () => {
    const table = defineTable<User>()({});
    expectTypeOf(table.__brand).toEqualTypeOf<"effortless-table">();
  });

  it("explicit generic → record.new is TableItem<User>", () => {
    defineTable<User>()({
      onRecord: async (args) => {
        type _rec = Expect<Equal<typeof args.record, TableRecord<User>>>;
        type _new = Expect<Equal<typeof args.record.new, TableItem<User> | undefined>>;
        type _batch = Expect<Equal<typeof args.batch, readonly TableRecord<User>[]>>;
      },
    });
  });

  it("schema → runtime validation with T fixed by generic", () => {
    defineTable<User>()({
      schema: (input): User => input as User,
      onRecord: async (args) => {
        type _new = Expect<Equal<typeof args.record.new, TableItem<User> | undefined>>;
        type _batch = Expect<Equal<typeof args.batch, readonly TableRecord<User>[]>>;
      },
    });
  });

  it("onRecord with setup + deps + config", () => {
    defineTable<User>()({
      deps: () => ({ usersTable }),
      config: ({ defineSecret }) => ({ webhookUrl: defineSecret({ key: "webhook-url" }) }),
      setup: ({ table, deps, config }) => ({ notifier: "sns" as const, users: deps.usersTable, url: config.webhookUrl, table }),
      onRecord: async (args) => {
        type _notifier = Expect<Equal<typeof args.notifier, "sns">>;
        type _users = Expect<Equal<typeof args.users, TableClient<User>>>;
        type _url = Expect<Equal<typeof args.url, string>>;
        type _table = Expect<Equal<typeof args.table, TableClient<User>>>;
      },
    });
  });

  it("minimal onRecord — only record and batch, no ctx properties", () => {
    defineTable<User>()({
      onRecord: async (args) => {
        type _rec = Expect<Equal<typeof args.record, TableRecord<User>>>;
        type _batch = Expect<Equal<typeof args.batch, readonly TableRecord<User>[]>>;
      },
    });
  });

  it("static → files available in setup, spread into onRecord", () => {
    defineTable<User>()({
      static: ["templates/*.html"],
      setup: ({ files }) => {
        type _files = Expect<Equal<typeof files, StaticFiles>>;
        return { tpl: files };
      },
      onRecord: async (args) => {
        type _tpl = Expect<Equal<typeof args.tpl, StaticFiles>>;
      },
    });
  });

});

// ── defineSecret ─────────────────────────────────────────────

describe("defineSecret type inference", () => {

  it("default → string", () => {
    const ref = defineSecret();
    expectTypeOf(ref.__brand).toEqualTypeOf<"effortless-secret">();
    expectTypeOf(ref.key).toEqualTypeOf<string | undefined>();
  });

  it("with transform → inferred from transform return", () => {
    const ref = defineSecret({ transform: Number });
    expectTypeOf(ref.transform).toEqualTypeOf<((raw: string) => number) | undefined>();
  });

  it("custom transform → inferred return type", () => {
    const ref = defineSecret({ key: "config", transform: (raw: string) => JSON.parse(raw) as { port: number } });
    expectTypeOf(ref).toMatchTypeOf<{ __brand: "effortless-secret" }>();
  });

});
