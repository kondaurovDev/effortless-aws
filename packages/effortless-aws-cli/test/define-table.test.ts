import { describe, it, expect, afterEach } from "vitest"
import * as path from "path"

import { extractTableConfigs } from "./helpers/extract-from-source"
import { importBundle } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

// Helper to create a DynamoDB stream record in single-table format
const makeRecord = (overrides: { pk?: string; sk?: string; tag?: string; data?: Record<string, unknown>; seq?: string; eventName?: string } = {}) => ({
  eventName: overrides.eventName ?? "INSERT",
  dynamodb: {
    Keys: { pk: { S: overrides.pk ?? "PK#1" }, sk: { S: overrides.sk ?? "SK#1" } },
    NewImage: {
      pk: { S: overrides.pk ?? "PK#1" },
      sk: { S: overrides.sk ?? "SK#1" },
      tag: { S: overrides.tag ?? "test" },
      data: { M: Object.fromEntries(
        Object.entries(overrides.data ?? { name: "Alice" }).map(([k, v]) => [k, typeof v === "number" ? { N: String(v) } : { S: String(v) }])
      )},
    },
    SequenceNumber: overrides.seq ?? "100",
  },
});

describe("defineTable", () => {

  describe("config extraction", () => {

    it("should extract config from named export (no pk/sk needed)", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({ billingMode: "PAY_PER_REQUEST" })
          .stream({
            streamView: "NEW_AND_OLD_IMAGES",
            batchSize: 50,
            maxRetries: 5,
          })
          .setup({ memory: 512 })
          .onRecord(async ({ record }) => {
            console.log(record);
          });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      const first = configs[0]!;
      expect(first.exportName).toBe("orders");
      expect(first.config.billingMode).toBe("PAY_PER_REQUEST");
      expect(first.config.stream?.streamView).toBe("NEW_AND_OLD_IMAGES");
      expect(first.config.stream?.batchSize).toBe(50);
      expect(first.config.stream?.maxRetries).toBe(5);
      expect(first.config.lambda?.memory).toBe(512);
      expect(first.hasHandler).toBe(true);
      // pk/sk should not be in config
      expect((first.config as any).pk).toBeUndefined();
      expect((first.config as any).sk).toBeUndefined();
    });

    it("should extract config from default export", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export default defineTable()
          .onRecord(async ({ record }) => {});
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      const first = configs[0]!;
      expect(first.exportName).toBe("default");
      expect(first.hasHandler).toBe(true);
    });

    it("should detect resource-only (no handler)", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const users = defineTable().build();
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.hasHandler).toBe(false);
    });

    it("should handle multiple exports", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()
          .onRecord(async ({ record }) => {});

        export const users = defineTable()
          .onRecord(async ({ record }) => {});
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(2);
      expect(configs.map(c => c.exportName)).toContain("orders");
      expect(configs.map(c => c.exportName)).toContain("users");
    });

  });

  describe("onRecord", () => {

    it("should bundle and invoke handler with single-table record", async () => {
      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_onRecord = [];

        export default defineTable()
          .onRecord(async ({ record }) => {
            globalThis.__test_onRecord.push(record.new?.data?.name);
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          makeRecord({ pk: "USER#1", sk: "ORDER#1", tag: "order", data: { name: "Alice" }, seq: "100" }),
          makeRecord({ pk: "USER#1", sk: "ORDER#2", tag: "order", data: { name: "Bob" }, seq: "200" }),
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_onRecord).toEqual(["Alice", "Bob"]);
    });

    it("should pass setup to handler", async () => {
      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_ctx = [];

        export default defineTable()
          .setup(({ table }) => ({ runtime: "mock-runtime" }))
          .onRecord(async ({ record, runtime }) => {
            globalThis.__test_ctx.push(runtime);
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [makeRecord()],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_ctx).toEqual(["mock-runtime"]);
    });

  });

  describe("schema", () => {

    it("should decode data portion through schema function", async () => {
      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_schema = [];

        const decodeData = (input) => ({
          name: String(input.name).toUpperCase(),
        });

        export default defineTable({ schema: decodeData })
          .onRecord(async ({ record }) => {
            globalThis.__test_schema.push(record.new?.data);
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [makeRecord({ data: { name: "alice" } })],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_schema).toEqual([
        { name: "ALICE" },
      ]);
    });

    it("should decode data in onRecord through schema function for multiple records", async () => {
      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_recordSchema = [];

        const decodeItem = (input) => ({
          value: Number(input.value) * 2,
        });

        export default defineTable({ schema: decodeItem })
          .onRecord(async ({ record }) => {
            globalThis.__test_recordSchema.push(record.new?.data);
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          makeRecord({ data: { value: "5" }, seq: "100" }),
          makeRecord({ data: { value: "10" }, seq: "200" }),
        ],
      });

      expect(response.batchItemFailures).toEqual([]);
      expect((globalThis as any).__test_recordSchema).toEqual([
        { value: 10 },
        { value: 20 },
      ]);
    });

    it("should report failure when schema throws", async () => {
      const handlerCode = `
        import { defineTable } from "effortless-aws";

        const strictDecode = (input) => {
          if (!input.name) throw new Error("name is required");
          return input;
        };

        export default defineTable({ schema: strictDecode })
          .onRecord(async ({ record }) => {});
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              Keys: { pk: { S: "PK#1" }, sk: { S: "SK#1" } },
              NewImage: { pk: { S: "PK#1" }, sk: { S: "SK#1" }, tag: { S: "test" }, data: { M: {} } },
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

    it("should pass table client to setup", async () => {
      process.env = { ...originalEnv, EFF_DEP_SELF: "table:test-project-dev-orders" };

      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_setupTable = null;

        export default defineTable()
          .setup(({ table }) => {
            globalThis.__test_setupTable = {
              tableName: table.tableName,
              hasPut: typeof table.put === "function",
            };
            return { initialized: true };
          })
          .onRecord(async ({ record, ctx }) => {});
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      await mod.handler({ Records: [makeRecord()] });

      const result = (globalThis as any).__test_setupTable;
      expect(result).not.toBeNull();
      expect(result.tableName).toBe("test-project-dev-orders");
      expect(result.hasPut).toBe(true);
    });

    it("should pass table client to onRecord via setup", async () => {
      process.env = { ...originalEnv, EFF_DEP_SELF: "table:test-project-dev-orders" };

      const handlerCode = `
        import { defineTable } from "effortless-aws";

        globalThis.__test_table = [];

        export default defineTable()
          .setup(({ table }) => ({ table }))
          .onRecord(async ({ record, table }) => {
            globalThis.__test_table.push({
              tableName: table.tableName,
              hasPut: typeof table.put === "function",
            });
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "table" });

      const response = await mod.handler({ Records: [makeRecord()] });

      expect(response.batchItemFailures).toEqual([]);
      const results = (globalThis as any).__test_table;
      expect(results).toHaveLength(1);
      expect(results[0].tableName).toBe("test-project-dev-orders");
      expect(results[0].hasPut).toBe(true);
    });

  });

});
