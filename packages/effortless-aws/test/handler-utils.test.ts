import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { parseDepValue, buildDeps, buildParams, ENV_DEP_PREFIX, ENV_PARAM_PREFIX, createHandlerRuntime } from "~aws/runtime/handler-utils"

// Mock only internal modules — no AWS SDK mocks needed here
const mockGetParameters = vi.fn();
vi.mock("~aws/runtime/ssm-client", () => ({
  getParameters: (...args: unknown[]) => mockGetParameters(...args),
}));

vi.mock("~aws/runtime/table-client", () => ({
  createTableClient: (name: string, opts?: { tagField?: string }) => ({ __mock: "table", name, opts }),
}));
vi.mock("~aws/runtime/bucket-client", () => ({
  createBucketClient: (name: string) => ({ __mock: "bucket", name }),
}));
vi.mock("~aws/runtime/email-client", () => ({
  createEmailClient: () => ({ __mock: "mailer" }),
}));
vi.mock("~aws/runtime/queue-client", () => ({
  createQueueClient: (name: string) => ({ __mock: "queue", name }),
}));

describe("parseDepValue", () => {
  it("splits type:name on first colon", () => {
    expect(parseDepValue("table:my-project-dev-orders")).toEqual({
      type: "table",
      name: "my-project-dev-orders",
    });
  });

  it("handles colons in resource name", () => {
    expect(parseDepValue("bucket:arn:aws:s3:::my-bucket")).toEqual({
      type: "bucket",
      name: "arn:aws:s3:::my-bucket",
    });
  });

  it("handles queue type", () => {
    expect(parseDepValue("queue:https://sqs.us-east-1.amazonaws.com/123/q")).toEqual({
      type: "queue",
      name: "https://sqs.us-east-1.amazonaws.com/123/q",
    });
  });
});

describe("buildDeps", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when deps is undefined", () => {
    expect(buildDeps(undefined)).toBeUndefined();
  });

  it("builds table client from env var", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}orders`]: "table:my-orders" };
    const deps = buildDeps({ orders: {} });
    expect(deps).toEqual({
      orders: { __mock: "table", name: "my-orders", opts: undefined },
    });
  });

  it("forwards tagField from dep handler __spec", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}orders`]: "table:my-orders" };
    const deps = buildDeps({ orders: { __spec: { tagField: "type" } } });
    expect(deps).toEqual({
      orders: { __mock: "table", name: "my-orders", opts: { tagField: "type" } },
    });
  });

  it("builds bucket client", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}files`]: "bucket:my-bucket" };
    expect(buildDeps({ files: {} })).toEqual({ files: { __mock: "bucket", name: "my-bucket" } });
  });

  it("builds mailer client", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}mail`]: "mailer:ignored" };
    expect(buildDeps({ mail: {} })).toEqual({ mail: { __mock: "mailer" } });
  });

  it("builds queue client", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}q`]: "queue:https://sqs.example.com/q" };
    expect(buildDeps({ q: {} })).toEqual({ q: { __mock: "queue", name: "https://sqs.example.com/q" } });
  });

  it("throws on missing env var", () => {
    process.env = { ...originalEnv };
    expect(() => buildDeps({ missing: {} })).toThrow(
      `Missing environment variable ${ENV_DEP_PREFIX}missing for dep "missing"`
    );
  });

  it("throws on unknown dep type", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}x`]: "unknown:res" };
    expect(() => buildDeps({ x: {} })).toThrow('Unknown dep type "unknown" for dep "x"');
  });

  it("accepts deps as a function", () => {
    process.env = { ...originalEnv, [`${ENV_DEP_PREFIX}orders`]: "table:tbl" };
    const deps = buildDeps(() => ({ orders: {} }));
    expect(deps).toHaveProperty("orders");
  });
});

describe("buildParams", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when params is undefined", async () => {
    expect(await buildParams(undefined)).toBeUndefined();
  });

  it("returns undefined when params is empty object", async () => {
    expect(await buildParams({})).toBeUndefined();
  });

  it("fetches SSM values and returns plain strings", async () => {
    process.env = { ...originalEnv, [`${ENV_PARAM_PREFIX}dbUrl`]: "/app/prod/db-url" };
    mockGetParameters.mockResolvedValue(new Map([["/app/prod/db-url", "postgres://localhost/db"]]));

    const result = await buildParams({ dbUrl: {} });
    expect(result).toEqual({ dbUrl: "postgres://localhost/db" });
    expect(mockGetParameters).toHaveBeenCalledWith(["/app/prod/db-url"]);
  });

  it("applies transform function", async () => {
    process.env = { ...originalEnv, [`${ENV_PARAM_PREFIX}port`]: "/app/prod/port" };
    mockGetParameters.mockResolvedValue(new Map([["/app/prod/port", "3000"]]));

    const result = await buildParams({ port: { transform: (v: string) => parseInt(v) } });
    expect(result).toEqual({ port: 3000 });
  });

  it("throws on missing env var", async () => {
    process.env = { ...originalEnv };
    await expect(buildParams({ missing: {} })).rejects.toThrow(
      `Missing environment variable ${ENV_PARAM_PREFIX}missing for param "missing"`
    );
  });

  it("defaults to empty string when SSM value not found", async () => {
    process.env = { ...originalEnv, [`${ENV_PARAM_PREFIX}key`]: "/app/dev/key" };
    mockGetParameters.mockResolvedValue(new Map());

    const result = await buildParams({ key: {} });
    expect(result).toEqual({ key: "" });
  });
});

describe("createHandlerRuntime", () => {
  describe("patchConsole / restoreConsole", () => {
    it("suppresses console.log and console.debug at error level", () => {
      const rt = createHandlerRuntime({}, "api", "error");
      const origLog = console.log;
      const origDebug = console.debug;

      rt.patchConsole();
      expect(console.log).not.toBe(origLog);
      expect(console.debug).not.toBe(origDebug);

      rt.restoreConsole();
      expect(console.log).toBe(origLog);
      expect(console.debug).toBe(origDebug);
    });

    it("suppresses only console.debug at info level", () => {
      const rt = createHandlerRuntime({}, "api", "info");
      const origLog = console.log;
      const origDebug = console.debug;

      rt.patchConsole();
      expect(console.log).toBe(origLog);
      expect(console.debug).not.toBe(origDebug);

      rt.restoreConsole();
    });

    it("suppresses nothing at debug level", () => {
      const rt = createHandlerRuntime({}, "api", "debug");
      const origLog = console.log;
      const origDebug = console.debug;

      rt.patchConsole();
      expect(console.log).toBe(origLog);
      expect(console.debug).toBe(origDebug);

      rt.restoreConsole();
    });
  });

  describe("logExecution", () => {
    it("logs JSON at info level without input/output", () => {
      const rt = createHandlerRuntime({}, "api", "info");
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      rt.logExecution(Date.now(), { path: "/test" }, { ok: true });

      expect(spy).toHaveBeenCalledOnce();
      const logged = JSON.parse(spy.mock.calls[0]![0]!);
      expect(logged.level).toBe("info");
      expect(logged.type).toBe("api");
      expect(logged.input).toBeUndefined();
      expect(logged.output).toBeUndefined();
      spy.mockRestore();
    });

    it("includes input/output at debug level", () => {
      const rt = createHandlerRuntime({}, "api", "debug");
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      rt.logExecution(Date.now(), { path: "/test" }, { ok: true });

      const logged = JSON.parse(spy.mock.calls[0]![0]!);
      expect(logged.input).toEqual({ path: "/test" });
      expect(logged.output).toEqual({ ok: true });
      spy.mockRestore();
    });

    it("does not log at error level", () => {
      const rt = createHandlerRuntime({}, "api", "error");
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      rt.logExecution(Date.now(), {}, {});

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("logError", () => {
    it("always logs errors regardless of level", () => {
      const rt = createHandlerRuntime({}, "api", "error");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      rt.logError(Date.now(), {}, new Error("boom"));

      expect(spy).toHaveBeenCalledOnce();
      const logged = JSON.parse(spy.mock.calls[0]![0]!);
      expect(logged.level).toBe("error");
      expect(logged.error).toBe("boom");
      spy.mockRestore();
    });

    it("stringifies non-Error values", () => {
      const rt = createHandlerRuntime({}, "api", "error");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      rt.logError(Date.now(), {}, "string error");

      const logged = JSON.parse(spy.mock.calls[0]![0]!);
      expect(logged.error).toBe("string error");
      spy.mockRestore();
    });
  });
});
