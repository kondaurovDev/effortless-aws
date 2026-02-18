import { describe, it, expect } from "vitest";
import { extractFifoQueueConfigs } from "~/build/bundle";
import { importBundle } from "./helpers/bundle-code";
import * as path from "path";

const projectDir = path.resolve(import.meta.dirname, "..");

// ============ SQS event helpers ============

const makeSQSRecord = (overrides: Record<string, unknown> = {}) => ({
  messageId: "msg-1",
  receiptHandle: "handle-1",
  body: JSON.stringify({ orderId: "123", action: "process" }),
  attributes: {
    MessageGroupId: "group-1",
    MessageDeduplicationId: "dedup-1",
    ApproximateReceiveCount: "1",
    SentTimestamp: "1234567890",
    ApproximateFirstReceiveTimestamp: "1234567891",
  },
  messageAttributes: {},
  md5OfBody: "",
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:eu-central-1:123456789:test.fifo",
  ...overrides,
});

const makeSQSEvent = (records: Record<string, unknown>[] = [makeSQSRecord()]) => ({
  Records: records,
});

// ============ Config extraction tests ============

describe("extractFifoQueueConfigs", () => {
  it("extracts config from named export", () => {
    const source = `
      import { defineFifoQueue } from "effortless-aws";
      export const orderQueue = defineFifoQueue({
        batchSize: 5,
        onMessage: async ({ message }) => {}
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("orderQueue");
    expect(configs[0]!.config.batchSize).toBe(5);
    expect(configs[0]!.hasHandler).toBe(true);
  });

  it("extracts config from default export", () => {
    const source = `
      import { defineFifoQueue } from "effortless-aws";
      export default defineFifoQueue({
        batchSize: 3,
        onBatch: async ({ messages }) => {}
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("default");
    expect(configs[0]!.config.batchSize).toBe(3);
    expect(configs[0]!.hasHandler).toBe(true);
  });

  it("strips runtime props from config", () => {
    const source = `
      import { defineFifoQueue } from "effortless-aws";
      export const q = defineFifoQueue({
        name: "my-queue",
        batchSize: 10,
        schema: (input) => input,
        onMessage: async ({ message }) => {},
        setup: () => ({ db: "pool" }),
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs[0]!.config.name).toBe("my-queue");
    expect(configs[0]!.config.batchSize).toBe(10);
    expect(configs[0]!.config).not.toHaveProperty("onMessage");
    expect(configs[0]!.config).not.toHaveProperty("schema");
    expect(configs[0]!.config).not.toHaveProperty("setup");
  });

  it("extracts deps keys", () => {
    const source = `
      import { defineFifoQueue } from "effortless-aws";
      import { orders } from "./orders";
      export const q = defineFifoQueue({
        deps: { orders },
        onMessage: async ({ message, deps }) => {}
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs[0]!.depsKeys).toEqual(["orders"]);
  });

  it("extracts param entries", () => {
    const source = `
      import { defineFifoQueue, param } from "effortless-aws";
      export const q = defineFifoQueue({
        config: { apiKey: param("api-key") },
        onMessage: async ({ message, config }) => {}
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs[0]!.paramEntries).toEqual([{ propName: "apiKey", ssmKey: "api-key" }]);
  });

  it("extracts static globs", () => {
    const source = `
      import { defineFifoQueue } from "effortless-aws";
      export const q = defineFifoQueue({
        static: ["src/templates/*.ejs"],
        onMessage: async ({ message }) => {}
      });
    `;
    const configs = extractFifoQueueConfigs(source);
    expect(configs[0]!.staticGlobs).toEqual(["src/templates/*.ejs"]);
  });
});

// ============ Runtime wrapper tests ============

describe("wrapFifoQueue", () => {
  it("processes messages with onMessage", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      globalThis.__test_messages = [];

      export default defineFifoQueue({
        onMessage: async ({ message }) => {
          globalThis.__test_messages.push(message.body);
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler(makeSQSEvent([
      makeSQSRecord({ messageId: "msg-1", body: JSON.stringify({ id: 1 }) }),
      makeSQSRecord({ messageId: "msg-2", body: JSON.stringify({ id: 2 }) }),
    ]));

    expect(response.batchItemFailures).toEqual([]);
    expect((globalThis as any).__test_messages).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("processes messages with onBatch", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      globalThis.__test_batch = null;

      export default defineFifoQueue({
        onBatch: async ({ messages }) => {
          globalThis.__test_batch = messages.map(m => m.body);
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler(makeSQSEvent([
      makeSQSRecord({ messageId: "msg-1", body: JSON.stringify({ x: 1 }) }),
      makeSQSRecord({ messageId: "msg-2", body: JSON.stringify({ x: 2 }) }),
    ]));

    expect(response.batchItemFailures).toEqual([]);
    expect((globalThis as any).__test_batch).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("reports partial batch failures for onMessage", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      export default defineFifoQueue({
        onMessage: async ({ message }) => {
          if (message.body.fail) throw new Error("boom");
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler(makeSQSEvent([
      makeSQSRecord({ messageId: "ok-1", body: JSON.stringify({ fail: false }) }),
      makeSQSRecord({ messageId: "fail-1", body: JSON.stringify({ fail: true }) }),
      makeSQSRecord({ messageId: "ok-2", body: JSON.stringify({ fail: false }) }),
    ]));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "fail-1" }]);
  });

  it("fails all messages on onBatch error", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      export default defineFifoQueue({
        onBatch: async ({ messages }) => {
          throw new Error("batch failed");
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler(makeSQSEvent([
      makeSQSRecord({ messageId: "msg-1" }),
      makeSQSRecord({ messageId: "msg-2" }),
    ]));

    expect(response.batchItemFailures).toHaveLength(2);
    expect(response.batchItemFailures.map((f: any) => f.itemIdentifier).sort()).toEqual(["msg-1", "msg-2"]);
  });

  it("applies schema to message body", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      globalThis.__test_decoded = [];

      export default defineFifoQueue({
        schema: (input) => {
          const obj = input;
          return { orderId: String(obj.orderId).toUpperCase() };
        },
        onMessage: async ({ message }) => {
          globalThis.__test_decoded.push(message.body);
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler(makeSQSEvent([
      makeSQSRecord({ messageId: "msg-1", body: JSON.stringify({ orderId: "abc" }) }),
    ]));

    expect(response.batchItemFailures).toEqual([]);
    expect((globalThis as any).__test_decoded).toEqual([{ orderId: "ABC" }]);
  });

  it("exposes FIFO message metadata", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      globalThis.__test_meta = null;

      export default defineFifoQueue({
        onMessage: async ({ message }) => {
          globalThis.__test_meta = {
            messageId: message.messageId,
            messageGroupId: message.messageGroupId,
            messageDeduplicationId: message.messageDeduplicationId,
            rawBody: message.rawBody,
          };
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    await mod.handler(makeSQSEvent([
      makeSQSRecord({
        messageId: "test-id",
        body: JSON.stringify({ data: 1 }),
        attributes: {
          MessageGroupId: "grp-42",
          MessageDeduplicationId: "dedup-99",
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890",
          ApproximateFirstReceiveTimestamp: "1234567891",
        },
      }),
    ]));

    const meta = (globalThis as any).__test_meta;
    expect(meta.messageId).toBe("test-id");
    expect(meta.messageGroupId).toBe("grp-42");
    expect(meta.messageDeduplicationId).toBe("dedup-99");
    expect(meta.rawBody).toBe(JSON.stringify({ data: 1 }));
  });

  it("handles empty event gracefully", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      export default defineFifoQueue({
        onMessage: async ({ message }) => {}
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    const response = await mod.handler({ Records: [] });

    expect(response.batchItemFailures).toEqual([]);
  });

  it("handles non-JSON body as raw string", async () => {
    const handlerCode = `
      import { defineFifoQueue } from "./src/handlers/define-fifo-queue";

      globalThis.__test_raw = null;

      export default defineFifoQueue({
        onMessage: async ({ message }) => {
          globalThis.__test_raw = message.body;
        }
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "fifoQueue" });
    await mod.handler(makeSQSEvent([
      makeSQSRecord({ body: "plain text message" }),
    ]));

    expect((globalThis as any).__test_raw).toBe("plain text message");
  });
});
