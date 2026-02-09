import { describe, it, expect } from "vitest"

import { extractConfigs, extractTableConfigs } from "~/build/bundle"

describe("params extraction", () => {

  describe("extractConfigs (HTTP)", () => {

    it("should extract param entries from handler", () => {
      const source = `
        import { defineHttp, param } from "effortless-aws";

        export const api = defineHttp({
          method: "GET",
          path: "/orders",
          params: {
            dbUrl: param("database-url"),
          },
          onRequest: async ({ req, params }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should extract multiple param entries", () => {
      const source = `
        import { defineHttp, param } from "effortless-aws";

        export const api = defineHttp({
          method: "GET",
          path: "/orders",
          params: {
            dbUrl: param("database-url"),
            apiKey: param("stripe-api-key"),
          },
          onRequest: async ({ req, params }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" },
        { propName: "apiKey", ssmKey: "stripe-api-key" }
      ]);
    });

    it("should extract param entries with transform", () => {
      const source = `
        import { defineHttp, param } from "effortless-aws";
        import TOML from "smol-toml";

        export const api = defineHttp({
          method: "GET",
          path: "/orders",
          params: {
            config: param("app-config", TOML.parse),
          },
          onRequest: async ({ req, params }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "config", ssmKey: "app-config" }
      ]);
    });

    it("should return empty paramEntries when no params property", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const hello = defineHttp({
          method: "GET",
          path: "/hello",
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([]);
    });

    it("should extract params from default export", () => {
      const source = `
        import { defineHttp, param } from "effortless-aws";

        export default defineHttp({
          method: "GET",
          path: "/orders",
          params: {
            dbUrl: param("database-url"),
          },
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should not leak params into static config", () => {
      const source = `
        import { defineHttp, param } from "effortless-aws";

        export const api = defineHttp({
          method: "GET",
          path: "/orders",
          params: {
            dbUrl: param("database-url"),
          },
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs[0]!.config).toEqual({ method: "GET", path: "/orders" });
      expect(configs[0]!.config).not.toHaveProperty("params");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract param entries from table handler", () => {
      const source = `
        import { defineTable, param } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          params: {
            webhookUrl: param("webhook-url"),
          },
          onRecord: async ({ record, params }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "webhookUrl", ssmKey: "webhook-url" }
      ]);
    });

    it("should return empty paramEntries for table without params", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([]);
    });

    it("should not leak params into table static config", () => {
      const source = `
        import { defineTable, param } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          params: {
            webhookUrl: param("webhook-url"),
          },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs[0]!.config).not.toHaveProperty("params");
      expect(configs[0]!.config.name).toBe("orders");
    });

  });

});
