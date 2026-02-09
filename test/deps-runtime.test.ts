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

import { wrapHttp } from "~/runtime/wrap-http"
import { wrapTableStream } from "~/runtime/wrap-table-stream"
import type { HttpHandler } from "~/handlers/define-http"
import type { TableHandler } from "~/handlers/define-table"

const makeHttpEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST", path: "/test" } },
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

  describe("HTTP handler (wrapHttp)", () => {

    it("should inject deps with table client into handler", async () => {
      process.env = { ...originalEnv, EFF_TABLE_orders: "test-project-dev-orders" };

      let capturedDeps: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "POST", path: "/orders" },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onRequest: async (args: any) => {
          capturedDeps = args.deps;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, undefined, any>;

      const wrapped = wrapHttp(handler);
      const response = await wrapped(makeHttpEvent());

      expect(response.statusCode).toBe(200);
      expect(capturedDeps).not.toBeNull();
      expect(capturedDeps.orders).toBeDefined();
      expect(capturedDeps.orders.tableName).toBe("test-project-dev-orders");
      expect(typeof capturedDeps.orders.put).toBe("function");
      expect(typeof capturedDeps.orders.get).toBe("function");
      expect(typeof capturedDeps.orders.delete).toBe("function");
      expect(typeof capturedDeps.orders.query).toBe("function");
    });

    it("should work with deps + context together", async () => {
      process.env = { ...originalEnv, EFF_TABLE_orders: "my-orders-table" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "POST", path: "/orders" },
        context: () => ({ env: "test" }),
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, any, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());

      expect(capturedArgs.ctx).toEqual({ env: "test" });
      expect(capturedArgs.deps.orders.tableName).toBe("my-orders-table");
    });

    it("should work with deps + schema together", async () => {
      process.env = { ...originalEnv, EFF_TABLE_orders: "my-orders-table" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "POST", path: "/orders" },
        schema: (input: unknown) => {
          const obj = input as any;
          if (!obj?.item) throw new Error("item required");
          return { item: obj.item };
        },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 201 };
        },
      } as unknown as HttpHandler<any, undefined, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent({ body: JSON.stringify({ item: "book" }) }));

      expect(capturedArgs.data).toEqual({ item: "book" });
      expect(capturedArgs.deps.orders.tableName).toBe("my-orders-table");
    });

    it("should throw when env var is missing for a dep", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_TABLE_orders;

      const handler = {
        __brand: "effortless-http",
        config: { method: "POST", path: "/orders" },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onRequest: async (args: any) => {
          return { status: 200, body: { table: args.deps.orders.tableName } };
        },
      } as unknown as HttpHandler<undefined, undefined, any>;

      const wrapped = wrapHttp(handler);

      await expect(wrapped(makeHttpEvent())).rejects.toThrow(
        'Missing environment variable EFF_TABLE_orders for dep "orders"'
      );
    });

    it("should not inject deps when handler has no deps", async () => {
      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/hello" },
        onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { hello: "world" } };
        },
      } as unknown as HttpHandler;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());

      expect(capturedArgs.deps).toBeUndefined();
    });

  });

  describe("Table stream handler (wrapTableStream)", () => {

    it("should inject deps into onRecord", async () => {
      process.env = { ...originalEnv, EFF_TABLE_users: "test-project-dev-users" };

      const capturedDeps: any[] = [];

      const handler = {
        __brand: "effortless-table",
        config: {},
        deps: { users: { __brand: "effortless-table", config: {} } },
        onRecord: async (args: any) => {
          capturedDeps.push({
            tableName: args.deps.users.tableName,
            hasPut: typeof args.deps.users.put === "function",
          });
        },
      } as unknown as TableHandler<any, any, any, any>;

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
      expect(capturedDeps).toHaveLength(1);
      expect(capturedDeps[0].tableName).toBe("test-project-dev-users");
      expect(capturedDeps[0].hasPut).toBe(true);
    });

    it("should inject deps into onBatch", async () => {
      process.env = { ...originalEnv, EFF_TABLE_users: "test-project-dev-users" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        deps: { users: { __brand: "effortless-table", config: {} } },
        onBatch: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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
      expect(capturedArgs).not.toBeNull();
      expect(capturedArgs.deps.users.tableName).toBe("test-project-dev-users");
      expect(capturedArgs.records).toHaveLength(2);
    });

    it("should inject deps + context into onRecord", async () => {
      process.env = { ...originalEnv, EFF_TABLE_users: "test-project-dev-users" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        context: () => ({ runtime: "test-runtime" }),
        deps: { users: { __brand: "effortless-table", config: {} } },
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.ctx).toEqual({ runtime: "test-runtime" });
      expect(capturedArgs.deps.users.tableName).toBe("test-project-dev-users");
    });

    it("should not inject deps when handler has no deps", async () => {
      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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

    it("should inject table client into onRecord", async () => {
      process.env = { ...originalEnv, EFF_TABLE_SELF: "my-project-dev-orders" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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

    it("should inject table client into onBatch", async () => {
      process.env = { ...originalEnv, EFF_TABLE_SELF: "my-project-dev-events" };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        onBatch: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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
      expect(capturedArgs.records).toHaveLength(1);
    });

    it("should inject table + deps + context together", async () => {
      process.env = {
        ...originalEnv,
        EFF_TABLE_SELF: "my-project-dev-orders",
        EFF_TABLE_users: "my-project-dev-users",
      };

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        context: () => ({ env: "test" }),
        deps: { users: { __brand: "effortless-table", config: {} } },
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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
      expect(capturedArgs.deps.users.tableName).toBe("my-project-dev-users");
      expect(capturedArgs.ctx).toEqual({ env: "test" });
    });

    it("should not inject table when EFF_TABLE_SELF is absent", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_TABLE_SELF;

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any>;

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
