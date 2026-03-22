import { describe, it, expect, expectTypeOf } from "vitest";
import { defineWorker } from "~aws/handlers/define-worker";
import { defineTable } from "~aws/handlers/define-table";
import type { WorkerClient } from "~aws/runtime/worker-client";
import type { TableClient } from "~aws/runtime/table-client";
import type { StaticFiles } from "~aws/handlers/shared";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Job = { type: "export"; userId: string };
type User = { name: string; email: string };

const usersTable = defineTable<User>().build();

// ── Builder pattern ────────────────────────────────────────────

describe("defineWorker builder", () => {

  it("minimal — onMessage only", () => {
    const w = defineWorker<Job>()
      .onMessage(async (msg) => {
        void msg;
      });

    expect(w.__brand).toBe("effortless-worker");
    expect(w.__spec).toEqual({});
    expect(w.onMessage).toBeTypeOf("function");
    expect(w.deps).toBeUndefined();
    expect(w.config).toBeUndefined();
    expect(w.setup).toBeUndefined();
    expect(w.static).toBeUndefined();
  });

  it("preserves options in __spec", () => {
    const w = defineWorker<Job>({ size: "1vCPU-2gb", idleTimeout: "10m" })
      .onMessage(async () => {});

    expect(w.__spec.size).toBe("1vCPU-2gb");
    expect(w.__spec.idleTimeout).toBe("10m");
  });

  it("preserves concurrency in __spec", () => {
    const w = defineWorker<Job>({ concurrency: 5 })
      .onMessage(async () => {});

    expect(w.__spec.concurrency).toBe(5);
  });

  it("deps are stored as factory function", () => {
    const w = defineWorker<Job>()
      .deps(() => ({ usersTable }))
      .onMessage(async () => {});

    expect(w.deps).toBeTypeOf("function");
  });

  it("config stores resolved secret refs", () => {
    const w = defineWorker<Job>()
      .config(({ defineSecret }) => ({
        apiKey: defineSecret({ key: "api-key" }),
      }))
      .onMessage(async () => {});

    expect(w.config).toBeDefined();
    expect((w.config as any).apiKey.__brand).toBe("effortless-secret");
  });

  it("include accumulates static globs", () => {
    const w = defineWorker<Job>()
      .include("templates/*.html")
      .include("assets/*.css")
      .onMessage(async () => {});

    expect(w.static).toEqual(["templates/*.html", "assets/*.css"]);
  });

  it("setup stores factory function", () => {
    const setupFn = () => ({ runtime: "test" });
    const w = defineWorker<Job>()
      .setup(setupFn)
      .onMessage(async () => {});

    expect(w.setup).toBe(setupFn);
  });

  it("setup with lambda options stores both", () => {
    const w = defineWorker<Job>()
      .setup(() => ({ db: "pg" }), { memory: 256 })
      .onMessage(async () => {});

    expect(w.setup).toBeTypeOf("function");
    expect(w.__spec.lambda?.memory).toBe(256);
  });

  it("setup with lambda-only options (no factory)", () => {
    const w = defineWorker<Job>()
      .setup({ memory: 128, timeout: "30s" })
      .onMessage(async () => {});

    expect(w.__spec.lambda?.memory).toBe(128);
    expect(w.__spec.lambda?.timeout).toBe("30s");
    expect(w.setup).toBeUndefined();
  });

  it("onError and onCleanup are stored", () => {
    const onErr = () => {};
    const onClean = () => {};
    const w = defineWorker<Job>()
      .onError(onErr)
      .onCleanup(onClean)
      .onMessage(async () => {});

    expect(w.onError).toBe(onErr);
    expect(w.onCleanup).toBe(onClean);
  });

  it("full chain — deps + config + include + setup + onError + onMessage", () => {
    const w = defineWorker<Job>({ size: "0.5vCPU-1gb", concurrency: 3 })
      .deps(() => ({ usersTable }))
      .config(({ defineSecret }) => ({ key: defineSecret() }))
      .include("tpl/*.ejs")
      .setup(({ deps, config, files }) => ({
        users: deps.usersTable,
        key: config.key,
        tpl: files,
      }))
      .onError(({ error }) => console.error(error))
      .onMessage(async (msg, { users, key, tpl }) => {
        void msg;
      });

    expect(w.__brand).toBe("effortless-worker");
    expect(w.__spec.size).toBe("0.5vCPU-1gb");
    expect(w.__spec.concurrency).toBe(3);
    expect(w.deps).toBeTypeOf("function");
    expect(w.config).toBeDefined();
    expect(w.static).toEqual(["tpl/*.ejs"]);
    expect(w.setup).toBeTypeOf("function");
    expect(w.onError).toBeTypeOf("function");
    expect(w.onMessage).toBeTypeOf("function");
  });
});

// ── Type inference ─────────────────────────────────────────────

describe("defineWorker type inference", () => {

  it("onMessage receives typed message", () => {
    defineWorker<Job>()
      .onMessage(async (msg) => {
        type _msg = Expect<Equal<typeof msg, Job>>;
      });
  });

  it("onMessage receives ctx from setup", () => {
    defineWorker<Job>()
      .setup(() => ({ db: "pg" as const }))
      .onMessage(async (msg, { db }) => {
        type _db = Expect<Equal<typeof db, "pg">>;
      });
  });

  it("deps → typed in setup and onMessage ctx", () => {
    defineWorker<Job>()
      .deps(() => ({ usersTable }))
      .setup(({ deps }) => {
        type _users = Expect<Equal<typeof deps.usersTable, TableClient<User>>>;
        return { users: deps.usersTable };
      })
      .onMessage(async (msg, { users }) => {
        type _users = Expect<Equal<typeof users, TableClient<User>>>;
      });
  });

  it("config → typed in setup", () => {
    defineWorker<Job>()
      .config(({ defineSecret }) => ({
        dbUrl: defineSecret({ key: "db-url" }),
        retries: defineSecret<number>({ key: "retries", transform: Number }),
      }))
      .setup(({ config }) => {
        type _url = Expect<Equal<typeof config.dbUrl, string>>;
        type _retries = Expect<Equal<typeof config.retries, number>>;
        return {};
      })
      .onMessage(async () => {});
  });

  it("include → files available in setup", () => {
    defineWorker<Job>()
      .include("templates/*.html")
      .setup(({ files }) => {
        type _files = Expect<Equal<typeof files, StaticFiles>>;
        return { tpl: files };
      })
      .onMessage(async (msg, { tpl }) => {
        type _tpl = Expect<Equal<typeof tpl, StaticFiles>>;
      });
  });

  it("brand is effortless-worker", () => {
    const w = defineWorker<Job>().onMessage(async () => {});
    expectTypeOf(w.__brand).toEqualTypeOf<"effortless-worker">();
  });

  it("worker as dep resolves to WorkerClient<T>", () => {
    const worker = defineWorker<Job>().onMessage(async () => {});

    defineWorker<string>()
      .deps(() => ({ worker }))
      .setup(({ deps }) => {
        type _wc = Expect<Equal<typeof deps.worker, WorkerClient<Job>>>;
        return {};
      })
      .onMessage(async () => {});
  });
});
