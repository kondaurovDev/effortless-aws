import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Mocks ───────────────────────────────────────────────────────

const mockGetParameters = vi.fn().mockResolvedValue(new Map());
vi.mock("~aws/runtime/ssm-client", () => ({
  getParameters: (...args: unknown[]) => mockGetParameters(...args),
}));

vi.mock("~aws/runtime/table-client", () => ({
  createTableClient: (name: string, opts?: { tagField?: string }) => ({ __mock: "table", name, opts }),
}));
vi.mock("~aws/runtime/bucket-client", () => ({
  createBucketClient: (name: string) => ({ __mock: "bucket", name }),
  createBucketClientWithEntities: (name: string, config: any) => ({ __mock: "bucket-entities", name, config }),
}));
vi.mock("~aws/runtime/email-client", () => ({
  createEmailClient: () => ({ __mock: "mailer" }),
}));
vi.mock("~aws/runtime/queue-client", () => ({
  createQueueClient: (name: string) => ({ __mock: "queue", name }),
}));

import { createHandlerRuntime, ENV_DEP_PREFIX, ENV_PARAM_PREFIX } from "~aws/runtime/handler-utils"

// ── Tests ───────────────────────────────────────────────────────

describe("HandlerRuntime.preload()", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("runs full init chain without errors when handler has no deps/config/setup", async () => {
    const rt = createHandlerRuntime({}, "api", "info");
    await expect(rt.preload()).resolves.toBeUndefined();
  });

  it("resolves deps during preload", async () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}orders`]: "table:my-table" };
    const rt = createHandlerRuntime(
      { deps: { orders: {} } },
      "api",
      "info",
    );

    await rt.preload();

    // After preload, commonArgs should have the deps already resolved
    const args = await rt.commonArgs();
    expect(args.deps).toEqual({ orders: { __mock: "table", name: "my-table", opts: undefined } });
  });

  it("resolves config (params) during preload", async () => {
    process.env = { ...originalEnv, [`${ENV_PARAM_PREFIX}dbUrl`]: "/app/prod/db-url" };
    mockGetParameters.mockResolvedValue(new Map([["/app/prod/db-url", "postgres://localhost/db"]]));

    const rt = createHandlerRuntime(
      { config: { dbUrl: {} } },
      "api",
      "info",
    );

    await rt.preload();

    const args = await rt.commonArgs();
    expect(args.config).toEqual({ dbUrl: "postgres://localhost/db" });
  });

  it("runs setup during preload", async () => {
    const setup = vi.fn().mockResolvedValue({ initialized: true });
    const rt = createHandlerRuntime(
      { setup },
      "api",
      "info",
    );

    await rt.preload();
    expect(setup).toHaveBeenCalledOnce();

    // Calling commonArgs afterwards should NOT re-run setup
    await rt.commonArgs();
    expect(setup).toHaveBeenCalledOnce();
  });

  it("calls each init step only once even if preload and commonArgs run", async () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}orders`]: "table:my-table" };
    const setup = vi.fn().mockResolvedValue({ db: "pool" });
    const rt = createHandlerRuntime(
      { deps: { orders: {} }, setup },
      "api",
      "info",
    );

    await rt.preload();
    expect(setup).toHaveBeenCalledOnce();

    // Call commonArgs multiple times -- setup should not be called again
    await rt.commonArgs();
    await rt.commonArgs();
    expect(setup).toHaveBeenCalledOnce();
  });
});

describe("__preload on wrapper functions", () => {
  // These tests verify that each wrapper exposes __preload as a function.
  // We mock createHandlerRuntime to return a mock with preload.

  const mockPreload = vi.fn().mockResolvedValue(undefined);
  const mockPatchConsole = vi.fn();
  const mockRestoreConsole = vi.fn();
  const mockLogExecution = vi.fn();
  const mockLogError = vi.fn();
  const mockCommonArgs = vi.fn().mockResolvedValue({ ctx: undefined });

  // We need a separate test approach for __preload since the wrap-* modules
  // import createHandlerRuntime at module level. Rather than re-mock everything,
  // we test that wrapApi (which does NOT mock createHandlerRuntime) exposes __preload.

  it("wrapApi returns a handler with __preload", async () => {
    // wrapApi is already imported in wrap-api.test.ts with real createHandlerRuntime
    // We just need to check the property exists
    const { wrapApi } = await import("~aws/runtime/wrap-api");

    const fn = wrapApi({
      __brand: "effortless-api",
      __spec: { basePath: "/api" },
      routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "ok" }) }],
    } as any);

    expect(typeof (fn as any).__preload).toBe("function");
  });

  it("wrapApi.__preload returns a Promise", async () => {
    const { wrapApi } = await import("~aws/runtime/wrap-api");

    const fn = wrapApi({
      __brand: "effortless-api",
      __spec: { basePath: "/api" },
      routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "ok" }) }],
    } as any);

    const result = (fn as any).__preload();
    expect(result).toBeInstanceOf(Promise);
    await result; // should not throw
  });

  it("wrapApi in streaming fallback mode also exposes __preload", async () => {
    const { wrapApi } = await import("~aws/runtime/wrap-api");

    const fn = wrapApi({
      __brand: "effortless-api",
      __spec: { basePath: "/api", stream: true },
      routes: [{ method: "GET", path: "/hello", onRequest: () => ({ status: 200, body: "ok" }) }],
    } as any);

    expect(typeof (fn as any).__preload).toBe("function");
  });

  it("wrapCron returns a handler with __preload", async () => {
    const { wrapCron } = await import("~aws/runtime/wrap-cron");

    const fn = wrapCron({
      __brand: "effortless-cron",
      __spec: { schedule: "rate(1 hour)", lambda: {} },
      onTick: vi.fn(),
    } as any);

    expect(typeof (fn as any).__preload).toBe("function");
    await (fn as any).__preload();
  });

  it("wrapBucket returns a handler with __preload", async () => {
    const { wrapBucket } = await import("~aws/runtime/wrap-bucket");

    const fn = wrapBucket({
      __brand: "effortless-bucket",
      __spec: { lambda: {} },
      onObjectCreated: vi.fn(),
    } as any);

    expect(typeof (fn as any).__preload).toBe("function");
    await (fn as any).__preload();
  });

  it("wrapQueue returns a handler with __preload", async () => {
    const { wrapQueue } = await import("~aws/runtime/wrap-queue");

    const fn = wrapQueue({
      __brand: "effortless-queue",
      __spec: { lambda: {} },
      onMessage: vi.fn(),
    } as any);

    expect(typeof (fn as any).__preload).toBe("function");
    await (fn as any).__preload();
  });
});
