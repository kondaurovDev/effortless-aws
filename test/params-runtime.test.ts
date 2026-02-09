import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"

// Mock DynamoDB client
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

// Mock SSM client
const mockGetParameters = vi.fn();

vi.mock("@aws-sdk/client-ssm", () => ({
  SSM: class {
    getParameters = mockGetParameters;
  },
}));

import { wrapHttp } from "~/runtime/wrap-http"
import { wrapTableStream } from "~/runtime/wrap-table-stream"
import type { HttpHandler } from "~/handlers/define-http"
import type { TableHandler } from "~/handlers/define-table"

const makeHttpEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "GET", path: "/test" } },
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

const setupSsmMock = (params: Record<string, string>) => {
  mockGetParameters.mockResolvedValue({
    Parameters: Object.entries(params).map(([name, value]) => ({
      Name: name,
      Value: value,
    })),
  });
};

describe("params runtime injection", () => {

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("HTTP handler (wrapHttp)", () => {

    it("should inject resolved params into handler", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost:5432/db" });

      let capturedParams: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        onRequest: async (args: any) => {
          capturedParams = args.params;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, undefined, any, any>;

      const wrapped = wrapHttp(handler);
      const response = await wrapped(makeHttpEvent());

      expect(response.statusCode).toBe(200);
      expect(capturedParams).not.toBeNull();
      expect(capturedParams.dbUrl).toBe("postgres://localhost:5432/db");
    });

    it("should apply transform function to param value", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_config: "/myapp/prod/app-config",
      };

      setupSsmMock({ "/myapp/prod/app-config": '{"feature": true}' });

      let capturedParams: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          config: {
            __brand: "effortless-param",
            key: "app-config",
            transform: (raw: string) => JSON.parse(raw),
          },
        },
        onRequest: async (args: any) => {
          capturedParams = args.params;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, undefined, any, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());

      expect(capturedParams.config).toEqual({ feature: true });
    });

    it("should pass params to context factory", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedCtx: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        context: ({ params }: any) => ({ poolUrl: params.dbUrl }),
        onRequest: async (args: any) => {
          capturedCtx = args.ctx;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, any, any, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());

      expect(capturedCtx).toEqual({ poolUrl: "postgres://localhost/db" });
    });

    it("should work with params + deps together", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
        EFF_TABLE_orders: "myapp-prod-orders",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { ok: true } };
        },
      } as unknown as HttpHandler<undefined, undefined, any, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());

      expect(capturedArgs.params.dbUrl).toBe("postgres://localhost/db");
      expect(capturedArgs.deps.orders.tableName).toBe("myapp-prod-orders");
    });

    it("should throw when env var is missing for a param", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_PARAM_dbUrl;

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        onRequest: async (args: any) => {
          return { status: 200, body: {} };
        },
      } as unknown as HttpHandler<undefined, undefined, any, any>;

      const wrapped = wrapHttp(handler);

      await expect(wrapped(makeHttpEvent())).rejects.toThrow(
        'Missing environment variable EFF_PARAM_dbUrl for param "dbUrl"'
      );
    });

    it("should not inject params when handler has no params", async () => {
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

      expect(capturedArgs.params).toBeUndefined();
      expect(mockGetParameters).not.toHaveBeenCalled();
    });

    it("should cache params across invocations", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      const handler = {
        __brand: "effortless-http",
        config: { method: "GET", path: "/test" },
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        onRequest: async (args: any) => {
          return { status: 200, body: { url: args.params.dbUrl } };
        },
      } as unknown as HttpHandler<undefined, undefined, any, any>;

      const wrapped = wrapHttp(handler);
      await wrapped(makeHttpEvent());
      await wrapped(makeHttpEvent());

      // SSM should only be called once (cached)
      expect(mockGetParameters).toHaveBeenCalledTimes(1);
    });

  });

  describe("Table stream handler (wrapTableStream)", () => {

    it("should inject params into onRecord", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_webhookUrl: "/myapp/prod/webhook-url",
      };

      setupSsmMock({ "/myapp/prod/webhook-url": "https://hooks.example.com" });

      let capturedParams: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        params: {
          webhookUrl: { __brand: "effortless-param", key: "webhook-url" },
        },
        onRecord: async (args: any) => {
          capturedParams = args.params;
        },
      } as unknown as TableHandler<any, any, any, any, any>;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedParams).not.toBeNull();
      expect(capturedParams.webhookUrl).toBe("https://hooks.example.com");
    });

    it("should inject params into onBatch", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_apiKey: "/myapp/prod/api-key",
      };

      setupSsmMock({ "/myapp/prod/api-key": "sk_test_123" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        params: {
          apiKey: { __brand: "effortless-param", key: "api-key" },
        },
        onBatch: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any, any>;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.params.apiKey).toBe("sk_test_123");
      expect(capturedArgs.records).toHaveLength(1);
    });

    it("should pass params to context in table handler", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        params: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        context: ({ params }: any) => ({ poolUrl: params.dbUrl }),
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any, any>;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.ctx).toEqual({ poolUrl: "postgres://localhost/db" });
      expect(capturedArgs.params.dbUrl).toBe("postgres://localhost/db");
    });

    it("should not inject params when table handler has no params", async () => {
      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        config: {},
        onRecord: async (args: any) => {
          capturedArgs = args;
        },
      } as unknown as TableHandler<any, any, any, any, any>;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([
        {
          eventName: "INSERT",
          keys: { id: { S: "1" } },
          newImage: { id: { S: "1" } },
          sequenceNumber: "100",
        },
      ]));

      expect(capturedArgs.params).toBeUndefined();
      expect(mockGetParameters).not.toHaveBeenCalled();
    });

  });

});
