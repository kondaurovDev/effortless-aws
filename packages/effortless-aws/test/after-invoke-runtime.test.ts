import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {
    putItem = vi.fn();
    getItem = vi.fn();
    deleteItem = vi.fn();
    query = vi.fn();
  },
}));

import { wrapApi } from "~aws/runtime/wrap-api"
import { wrapTableStream } from "~aws/runtime/wrap-table-stream"
import { wrapFifoQueue } from "~aws/runtime/wrap-fifo-queue"
import type { ApiHandler } from "~aws/handlers/define-api"
import type { TableHandler } from "~aws/handlers/define-table"
import type { FifoQueueHandler } from "~aws/handlers/define-fifo-queue"

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

const makeSqsEvent = (messages: Array<{ body: string; messageId?: string }>) => ({
  Records: messages.map((m, i) => ({
    messageId: m.messageId ?? `msg-${i}`,
    receiptHandle: `handle-${i}`,
    body: m.body,
    attributes: { MessageGroupId: "group-1" },
    messageAttributes: {},
  })),
});

describe("onAfterInvoke lifecycle hook", () => {

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("API handler (wrapApi)", () => {

    it("should call onAfterInvoke after successful invocation", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        onAfterInvoke: afterInvoke,
        routes: [{ method: "POST", path: "/run", onRequest: async () => ({ status: 200, body: { ok: true } }) }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(afterInvoke).toHaveBeenCalledOnce();
    });

    it("should call onAfterInvoke after handler error", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        onAfterInvoke: afterInvoke,
        routes: [{ method: "POST", path: "/run", onRequest: async () => { throw new Error("boom"); } }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(afterInvoke).toHaveBeenCalledOnce();
    });

    it("should not throw when onAfterInvoke itself throws", async () => {
      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        onAfterInvoke: () => { throw new Error("afterInvoke error"); },
        routes: [{ method: "POST", path: "/run", onRequest: async () => ({ status: 200, body: { ok: true } }) }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      const result = await wrapped(makeApiEvent());

      expect(result.statusCode).toBe(200);
    });

    it("should receive ctx and deps in onAfterInvoke args", async () => {
      process.env = { ...originalEnv, EFF_DEP_orders: "table:test-orders" };

      let capturedArgs: any = null;
      const afterInvoke = vi.fn((args: any) => { capturedArgs = args; });

      const handler = {
        __brand: "effortless-api",
        __spec: { basePath: "/test" },
        setup: () => ({ env: "test" }),
        deps: { orders: { __brand: "effortless-table", config: {} } },
        onAfterInvoke: afterInvoke,
        routes: [{ method: "POST", path: "/run", onRequest: async () => ({ status: 200, body: { ok: true } }) }],
      } as unknown as ApiHandler;

      const wrapped = wrapApi(handler);
      await wrapped(makeApiEvent());

      expect(capturedArgs.env).toEqual("test");
    });

  });

  describe("Table stream handler (wrapTableStream)", () => {

    it("should call onAfterInvoke after processing records", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        onAfterInvoke: afterInvoke,
        onRecord: async () => {},
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      await wrapped(makeStreamEvent([{
        eventName: "INSERT",
        keys: { id: { S: "1" } },
        newImage: { id: { S: "1" } },
        sequenceNumber: "100",
      }]));

      expect(afterInvoke).toHaveBeenCalledOnce();
    });

    it("should call onAfterInvoke even when records fail", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-table",
        __spec: {},
        onAfterInvoke: afterInvoke,
        onRecord: async () => { throw new Error("record error"); },
      } as unknown as TableHandler;

      const wrapped = wrapTableStream(handler);
      const result = await wrapped(makeStreamEvent([{
        eventName: "INSERT",
        keys: { id: { S: "1" } },
        newImage: { id: { S: "1" } },
        sequenceNumber: "100",
      }]));

      expect(result.batchItemFailures).toHaveLength(1);
      expect(afterInvoke).toHaveBeenCalledOnce();
    });

  });

  describe("FIFO queue handler (wrapFifoQueue)", () => {

    it("should call onAfterInvoke after processing messages", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-fifo-queue",
        __spec: {},
        onAfterInvoke: afterInvoke,
        onMessage: async () => {},
      } as unknown as FifoQueueHandler;

      const wrapped = wrapFifoQueue(handler);
      await wrapped(makeSqsEvent([{ body: '{"test":true}' }]));

      expect(afterInvoke).toHaveBeenCalledOnce();
    });

    it("should call onAfterInvoke even when messages fail", async () => {
      const afterInvoke = vi.fn();

      const handler = {
        __brand: "effortless-fifo-queue",
        __spec: {},
        onAfterInvoke: afterInvoke,
        onMessage: async () => { throw new Error("message error"); },
      } as unknown as FifoQueueHandler;

      const wrapped = wrapFifoQueue(handler);
      const result = await wrapped(makeSqsEvent([{ body: '{"test":true}' }]));

      expect(result.batchItemFailures).toHaveLength(1);
      expect(afterInvoke).toHaveBeenCalledOnce();
    });

  });

});
