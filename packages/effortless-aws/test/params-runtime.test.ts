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

import { wrapApi } from "~aws/runtime/wrap-api"
import { wrapTableStream } from "~aws/runtime/wrap-table-stream"
import type { ApiHandler } from "~aws/handlers/define-api"
import type { TableHandler } from "~aws/handlers/define-table"

const makeHttpEvent = (overrides: Record<string, unknown> = {}) => ({
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

  describe("HTTP handler (wrapApi)", () => {

    it("should inject resolved params into handler", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost:5432/db" });

      let capturedConfig: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedConfig = args.config;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      const response = await wrapped(makeHttpEvent());

      expect(response.statusCode).toBe(200);
      expect(capturedConfig).not.toBeNull();
      expect(capturedConfig.dbUrl).toBe("postgres://localhost:5432/db");
    });

    it("should apply transform function to param value", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_appConfig: "/myapp/prod/app-config",
      };

      setupSsmMock({ "/myapp/prod/app-config": '{"feature": true}' });

      let capturedConfig: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          appConfig: {
            __brand: "effortless-param",
            key: "app-config",
            transform: (raw: string) => JSON.parse(raw),
          },
        },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedConfig = args.config;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeHttpEvent());

      expect(capturedConfig.appConfig).toEqual({ feature: true });
    });

    it("should pass params to setup factory", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedCtx: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        setup: ({ config }: any) => ({ poolUrl: config.dbUrl }),
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedCtx = args;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeHttpEvent());

      expect(capturedCtx.poolUrl).toEqual("postgres://localhost/db");
    });

    it("should work with params + deps together", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
        EFF_DEP_orders: "table:myapp-prod-orders",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        deps: { orders: { __brand: "effortless-table", config: {} } },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          capturedArgs = args;
          return { status: 200, body: { ok: true } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeHttpEvent());

      expect(capturedArgs.config.dbUrl).toBe("postgres://localhost/db");
      expect(capturedArgs.deps.orders.tableName).toBe("myapp-prod-orders");
    });

    it("should throw when env var is missing for a param", async () => {
      process.env = { ...originalEnv };
      delete process.env.EFF_PARAM_dbUrl;

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          return { status: 200, body: {} };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);

      await expect(wrapped(makeHttpEvent())).rejects.toThrow(
        'Missing environment variable EFF_PARAM_dbUrl for param "dbUrl"'
      );
    });

    it("should not inject params when handler has no params", async () => {
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
      await wrapped(makeHttpEvent());

      expect(capturedArgs.config).toBeUndefined();
      expect(mockGetParameters).not.toHaveBeenCalled();
    });

    it("should cache params across invocations", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        routes: [{ method: "POST", path: "/run", onRequest: async (args: any) => {
          return { status: 200, body: { url: args.config.dbUrl } };
        } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeHttpEvent());
      await wrapped(makeHttpEvent());

      // SSM should only be called once (cached)
      expect(mockGetParameters).toHaveBeenCalledTimes(1);
    });

  });

  describe("Table stream handler (wrapTableStream)", () => {

    it("should pass params to setup, spread ctx into onRecord", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_webhookUrl: "/myapp/prod/webhook-url",
      };

      setupSsmMock({ "/myapp/prod/webhook-url": "https://hooks.example.com" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        config: {
          webhookUrl: { __brand: "effortless-param", key: "webhook-url" },
        },
        setup: ({ config }: any) => ({ webhookUrl: config.webhookUrl }),
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

      expect(capturedArgs.webhookUrl).toBe("https://hooks.example.com");
    });

    it("should pass params to setup, spread ctx into onRecord", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_apiKey: "/myapp/prod/api-key",
      };

      setupSsmMock({ "/myapp/prod/api-key": "sk_test_123" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        config: {
          apiKey: { __brand: "effortless-param", key: "api-key" },
        },
        setup: ({ config }: any) => ({ apiKey: config.apiKey }),
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

      expect(capturedArgs.apiKey).toBe("sk_test_123");
      expect(capturedArgs.record).toBeDefined();
    });

    it("should pass params to setup in table handler (ctx spread)", async () => {
      process.env = {
        ...originalEnv,
        EFF_PARAM_dbUrl: "/myapp/prod/database-url",
      };

      setupSsmMock({ "/myapp/prod/database-url": "postgres://localhost/db" });

      let capturedArgs: any = null;

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        config: {
          dbUrl: { __brand: "effortless-param", key: "database-url" },
        },
        setup: ({ config }: any) => ({ poolUrl: config.dbUrl }),
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

      expect(capturedArgs.poolUrl).toEqual("postgres://localhost/db");
    });

    it("should not inject params when table handler has no params", async () => {
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

      expect(capturedArgs.config).toBeUndefined();
      expect(mockGetParameters).not.toHaveBeenCalled();
    });

  });

});
