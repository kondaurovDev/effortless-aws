import { describe, it, expect, afterEach } from "vitest"
import * as path from "path"

import { extractTableConfigs } from "~/build/bundle"
import { importBundle } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

describe("defineTable", () => {

  describe("config extraction", () => {

    it("should extract config from named export", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          sk: { name: "createdAt", type: "number" },
          streamView: "NEW_AND_OLD_IMAGES",
          batchSize: 50,
          memory: 512,
          onRecord: async ({ record }) => {
            console.log(record);
          }
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      const first = configs[0]!;
      expect(first.exportName).toBe("orders");
      expect(first.config.name).toBe("orders");
      expect(first.config.pk).toEqual({ name: "id", type: "string" });
      expect(first.config.sk).toEqual({ name: "createdAt", type: "number" });
      expect(first.config.streamView).toBe("NEW_AND_OLD_IMAGES");
      expect(first.config.batchSize).toBe(50);
      expect(first.config.memory).toBe(512);
      expect(first.hasHandler).toBe(true);
    });

    it("should extract config from default export", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export default defineTable({
          name: "users",
          pk: { name: "userId", type: "string" },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      const first = configs[0]!;
      expect(first.exportName).toBe("default");
      expect(first.config.name).toBe("users");
      expect(first.config.pk).toEqual({ name: "userId", type: "string" });
      expect(first.hasHandler).toBe(true);
    });

    it("should detect resource-only (no handler)", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const users = defineTable({
          name: "users",
          pk: { name: "userId", type: "string" }
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.hasHandler).toBe(false);
    });

    it("should detect hasHandler for onBatch", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const events = defineTable({
          name: "events",
          pk: { name: "id", type: "string" },
          onBatch: async ({ records }) => {
            console.log(records);
          }
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.hasHandler).toBe(true);
    });

    it("should handle multiple exports", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          onRecord: async ({ record }) => {}
        });

        export const users = defineTable({
          name: "users",
          pk: { name: "userId", type: "string" },
          sk: { name: "email", type: "string" },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(2);
      expect(configs.map(c => c.exportName)).toContain("orders");
      expect(configs.map(c => c.exportName)).toContain("users");
    });

  });

  describe("onRecord", () => {

    it("should bundle and invoke handler", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_onRecord = [];

        export default defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          onRecord: async ({ record }) => {
            globalThis.__test_onRecord.push(record.new?.name);
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" }, name: { S: "Alice" } },
              SequenceNumber: "100",
            },
          },
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "2" } },
              NewImage: { id: { S: "2" }, name: { S: "Bob" } },
              SequenceNumber: "200",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_onRecord).toEqual(["Alice", "Bob"]);
    });

    it("should pass context to handler", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_ctx = [];

        export default defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          context: () => ({ runtime: "mock-runtime" }),
          onRecord: async ({ record, ctx }) => {
            globalThis.__test_ctx.push(ctx.runtime);
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" } },
              SequenceNumber: "100",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_ctx).toEqual(["mock-runtime"]);
    });

  });

  describe("onBatch", () => {

    it("should bundle and invoke handler", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_onBatch = [];

        export default defineTable({
          name: "events",
          pk: { name: "id", type: "string" },
          onBatch: async ({ records }) => {
            globalThis.__test_onBatch.push(...records.map(r => r.new?.name));
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" }, name: { S: "Alice" } },
              SequenceNumber: "100",
            },
          },
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "2" } },
              NewImage: { id: { S: "2" }, name: { S: "Bob" } },
              SequenceNumber: "200",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_onBatch).toEqual(["Alice", "Bob"]);
    });

    it("should report all records as failed when handler throws", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        export default defineTable({
          name: "events",
          pk: { name: "id", type: "string" },
          onBatch: async ({ records }) => {
            throw new Error("batch failed");
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" } },
              SequenceNumber: "100",
            },
          },
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "2" } },
              NewImage: { id: { S: "2" } },
              SequenceNumber: "200",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([
        { itemIdentifier: "100" },
        { itemIdentifier: "200" },
      ]);
    });

  });

  describe("schema", () => {

    it("should decode records through schema function", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_schema = [];

        const decodeUser = (input) => ({
          id: String(input.id),
          name: String(input.name).toUpperCase(),
        });

        export default defineTable({
          name: "users",
          pk: { name: "id", type: "string" },
          schema: decodeUser,
          onRecord: async ({ record }) => {
            globalThis.__test_schema.push(record.new);
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" }, name: { S: "alice" } },
              SequenceNumber: "100",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_schema).toEqual([
        { id: "1", name: "ALICE" },
      ]);
    });

    it("should decode records in onBatch through schema function", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_batchSchema = [];

        const decodeItem = (input) => ({
          id: String(input.id),
          value: Number(input.value) * 2,
        });

        export default defineTable({
          name: "items",
          pk: { name: "id", type: "string" },
          schema: decodeItem,
          onBatch: async ({ records }) => {
            globalThis.__test_batchSchema.push(...records.map(r => r.new));
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" }, value: { N: "5" } },
              SequenceNumber: "100",
            },
          },
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "2" } },
              NewImage: { id: { S: "2" }, value: { N: "10" } },
              SequenceNumber: "200",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_batchSchema).toEqual([
        { id: "1", value: 10 },
        { id: "2", value: 20 },
      ]);
    });

    it("should report failure when schema throws", async () => {
      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        const strictDecode = (input) => {
          if (!input.name) throw new Error("name is required");
          return input;
        };

        export default defineTable({
          name: "strict",
          pk: { name: "id", type: "string" },
          schema: strictDecode,
          onBatch: async ({ records }) => {}
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" } },
              SequenceNumber: "100",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([
        { itemIdentifier: "100" },
      ]);
    });

  });

  describe("table self-client", () => {

    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should pass table client to onRecord", async () => {
      process.env = { ...originalEnv, EFF_TABLE_SELF: "test-project-dev-orders" };

      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_table = [];

        export default defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          onRecord: async ({ record, table }) => {
            globalThis.__test_table.push({
              tableName: table.tableName,
              hasPut: typeof table.put === "function",
            });
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" } },
              SequenceNumber: "100",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      const results = (globalThis as any).__test_table;
      expect(results).toHaveLength(1);
      expect(results[0].tableName).toBe("test-project-dev-orders");
      expect(results[0].hasPut).toBe(true);
    });

    it("should pass table client to onBatch", async () => {
      process.env = { ...originalEnv, EFF_TABLE_SELF: "test-project-dev-events" };

      const handlerCode = `
        import { defineTable } from "./src/handlers/define-table";

        globalThis.__test_batchTable = null;

        export default defineTable({
          name: "events",
          pk: { name: "id", type: "string" },
          onBatch: async ({ records, table }) => {
            globalThis.__test_batchTable = {
              tableName: table.tableName,
              hasQuery: typeof table.query === "function",
            };
          }
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { id: { S: "1" } },
              NewImage: { id: { S: "1" } },
              SequenceNumber: "100",
            },
          },
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      const result = (globalThis as any).__test_batchTable;
      expect(result).not.toBeNull();
      expect(result.tableName).toBe("test-project-dev-events");
      expect(result.hasQuery).toBe(true);
    });

  });

});
