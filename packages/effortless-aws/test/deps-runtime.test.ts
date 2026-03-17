import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"

// Mock DynamoDB client before importing wrappers
const mockPutItem = vi.fn();
const mockGetItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockQuery = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {
    putItem = mockPutItem;
    getItem = mockGetItem;
    deleteItem = mockDeleteItem;
    query = mockQuery;
  },
}));

import { wrapApi } from "~aws/runtime/wrap-api"
import { wrapTableStream } from "~aws/runtime/wrap-table-stream"
import type { ApiHandler } from "~aws/handlers/define-api"
import type { TableHandler } from "~aws/handlers/define-table"

const makeApiEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST", path: "/test/run" } },
  headers: {},
  queryStringParameters: {},
  pathParameters: {},
  body: undefined as string | undefined,
  ...overrides,
});

const makeStreamEvent = (records: Array<{
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  keys: Record<string, unknown>;
  newImage?: Record<string, unknown>;
  sequenceNumber?: string;
}>) => ({
  Records: records.map(r => ({
    eventName: r.eventName,
    dynamodb: {
      Keys: r.keys,
      ...(r.newImage ? { NewImage: r.newImage } : {}),
      ...(r.sequenceNumber ? { SequenceNumber: r.sequenceNumber } : {}),
    },
  })),
});

describe("deps runtime injection", () => {

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("API handler (wrapApi)", () => {

    it("should inject deps with table client into handler", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:test-project-dev-orders" };

      let capturedDeps: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedDeps = args.deps;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      const response = await wrapped(makeApiEvent());

      expect(response.statusCode).toBe(200);
      expect(capturedDeps).not.toBeNull();
      expect(capturedDeps.orders).toBeDefined();
      expect(capturedDeps.orders.tableName).toBe("test-project-dev-orders");
      expect(typeof capturedDeps.orders.put).toBe("function");
      expect(typeof capturedDeps.orders.get).toBe("function");
      expect(typeof capturedDeps.orders.delete).toBe("function");
      expect(typeof capturedDeps.orders.query).toBe("function");
    });

    it("should work with deps + setup together", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:my-orders-table" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        setup: () => ({ env: "test" }),
        deps: { orders: { __brand: "effortless-table", config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(capturedArgs.env).toEqual("test");
      expect(capturedArgs.deps.orders.tableName).toBe("my-orders-table");
    });

    it("should work with deps + schema together", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:my-orders-table" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        routes: [{ method: "POST", path: "/run",
          onRequest: async (args: any) => {
            capturedArgs = args;
            return { status: 201 };
          },
        }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent({ body: JSON.stringify({ item: "book" }) }));

      expect(capturedArgs.req.body).toEqual({ item: "book" });
      expect(capturedArgs.deps.orders.tableName).toBe("my-orders-table");
    });

    it("should forward tagField from dep handler __spec to table client", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:test-project-dev-orders" };
      mockPutItem.mockResolvedValue({});

      let capturedDeps: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        deps: { orders: { __brand: "effortless-table", __spec: { tagField: "__tag" }, config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedDeps = args.deps;
          await args.deps.orders.put({ pk: "order#1", sk: "ORDER", data: { __tag: "Order", amount: 42 } });
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(capturedDeps.orders.tableName).toBe("test-project-dev-orders");
      // put() should extract tag from data["__tag"], not data["tag"]
      expect(mockPutItem).toHaveBeenCalledOnce();
      const putArgs = mockPutItem.mock.calls[0]![0];
      expect(putArgs.TableName).toBe("test-project-dev-orders");
      // The marshalled item should have tag = "Order" (extracted from data.__tag)
      expect(putArgs.Item.tag).toEqual({ S: "Order" });
    });

    it("should use default tagField when dep handler has no tagField in __spec", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:test-project-dev-orders" };
      mockPutItem.mockResolvedValue({});

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        deps: { orders: { __brand: "effortless-table", __spec: {}, config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          await args.deps.orders.put({ pk: "order#1", sk: "ORDER", data: { tag: "Order", amount: 42 } });
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      const putArgs = mockPutItem.mock.calls[0]![0];
      expect(putArgs.Item.tag).toEqual({ S: "Order" });
    });

    it("should throw when env var is missing for a dep", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_DEP_orders;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          return { status: 200, body: { table: args.deps.orders.tableName } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);

      await expect(wrapped(makeApiEvent())).rejects.toThrow(
        'Missing environment variable EFF_DEP_orders for dep "orders"'
      );
    });

    it("should not inject deps when handler has no deps", async () => {
      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { hello: "world" } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(capturedArgs.deps).toBeUndefined();
    });

  });

  describe("Table stream handler (wrapTableStream)", () => {

    it("should inject deps into setup, spread ctx into onRecord", async () => {
      process.env = { ...originalEnv, EFF_DEP_users: "table:test-project-dev-users" };

      const capturedArgs: any[] = [];

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        deps: { users: { __brand: "effortless-table", config: {} } },
        setup: ({ deps }: any) => ({ users: deps.users }),
        onRecord: async (args: any) => {
          capturedArgs.push(args);
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      const response = await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" }, name: { S: "Alice" } },
          sequenceNumber: "100",
        },
      ]));

      expect(response.batchItemFailures).toEqual([]);
      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0].users.tableName).toBe("test-project-dev-users");
      expect(typeof capturedArgs[0].users.put).toBe("function");
    });

    it("should inject deps into setup, spread ctx into onRecord", async () => {
      process.env = { ...originalEnv, EFF_DEP_users: "table:test-project-dev-users" };

      const capturedArgs: any[] = [];

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        deps: { users: { __brand: "effortless-table", config: {} } },
        setup: ({ deps }: any) => ({ users: deps.users }),
        onRecord: async (args: any) => {
          capturedArgs.push(args);
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      const response = await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
        {
          eventName: "INSERT",
          keys: { id: { S: "2" } },
          newImage: { id: { S: "2" } },
          sequenceNumber: "200",
        },
      ]));

      expect(response.batchItemFailures).toEqual([]);
      expect(capturedArgs).toHaveLength(2);
      expect(capturedArgs[0].users.tableName).toBe("test-project-dev-users");
    });

    it("should inject deps + setup into onRecord (ctx spread)", async () => {
      process.env = { ...originalEnv, EFF_DEP_users: "table:test-project-dev-users" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        setup: ({ deps }: any) => ({ runtime: "test-runtime", users: deps.users }),
        deps: { users: { __brand: "effortless-table", config: {} } },
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.runtime).toEqual("test-runtime");
      expect(capturedArgs.users.tableName).toBe("test-project-dev-users");
    });

    it("should not have deps in callback when handler has no deps", async () => {
      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.deps).toBeUndefined();
    });

  });

  describe("Table self-client (table arg)", () => {

    it("should inject table client into onRecord via setup", async () => {
      process.env = { ...originalEnv, EFF_DEP_SELF: "table:my-project-dev-orders" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        setup: ({ table }: any) => ({ table }),
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.table).toBeDefined();
      expect(capturedArgs.table.tableName).toBe("my-project-dev-orders");
      expect(typeof capturedArgs.table.put).toBe("function");
      expect(typeof capturedArgs.table.get).toBe("function");
      expect(typeof capturedArgs.table.delete).toBe("function");
      expect(typeof capturedArgs.table.query).toBe("function");
    });

    it("should inject table client into onRecord", async () => {
      process.env = { ...originalEnv, EFF_DEP_SELF: "table:my-project-dev-events" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        setup: ({ table }: any) => ({ table }),
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.table).toBeDefined();
      expect(capturedArgs.table.tableName).toBe("my-project-dev-events");
      expect(capturedArgs.record).toBeDefined();
      expect(capturedArgs.batch).toHaveLength(1);
    });

    it("should inject table + setup (ctx spread) together", async () => {
      process.env = {
        ...originalEnv,
        EFF_DEP_SELF: "table:my-project-dev-orders",
        EFF_DEP_users: "table:my-project-dev-users",
      };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        setup: ({ deps, table }: any) => ({ env: "test", users: deps.users, table }),
        deps: { users: { __brand: "effortless-table", config: {} } },
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.table.tableName).toBe("my-project-dev-orders");
      expect(capturedArgs.users.tableName).toBe("my-project-dev-users");
      expect(capturedArgs.env).toEqual("test");
    });

    it("should not inject table when EFF_DEP_SELF is absent", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_DEP_SELF;

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.table).toBeUndefined();
    });

  });

});
