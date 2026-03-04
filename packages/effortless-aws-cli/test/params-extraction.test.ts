import { describe, it, expect } from "vitest"

import { extractApiConfigs, extractTableConfigs } from "~cli/build/bundle"

describe("params extraction", () => {

  describe("extractApiConfigs", () => {

    it("should extract param entries from handler", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";

        export const api = defineApi({
          basePath: "/orders",
          config: {
            dbUrl: param("database-url"),
          },
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should extract multiple param entries", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";

        export const api = defineApi({
          basePath: "/orders",
          config: {
            dbUrl: param("database-url"),
            apiKey: param("stripe-api-key"),
          },
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" },
        { propName: "apiKey", ssmKey: "stripe-api-key" }
      ]);
    });

    it("should extract param entries with transform", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";
        import TOML from "smol-toml";

        export const api = defineApi({
          basePath: "/orders",
          config: {
            appConfig: param("app-config", TOML.parse),
          },
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "appConfig", ssmKey: "app-config" }
      ]);
    });

    it("should return empty paramEntries when no params property", () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const hello = defineApi({
          basePath: "/hello",
          get: { "/": async ({ req }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.paramEntries).toEqual([]);
    });

    it("should extract params from default export", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";

        export default defineApi({
          basePath: "/orders",
          config: {
            dbUrl: param("database-url"),
          },
          get: { "/": async ({ req }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.paramEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should not leak params into static config", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";

        export const api = defineApi({
          basePath: "/orders",
          config: {
            dbUrl: param("database-url"),
          },
          get: { "/": async ({ req }) => ({ status: 200 }) }
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs[0]!.config).toEqual({ basePath: "/orders" });
      expect(configs[0]!.config).not.toHaveProperty("config");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract param entries from table handler", () => {
      const source = `
        import { defineTable, param } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          config: {
            webhookUrl: param("webhook-url"),
          },
          onRecord: async ({ record, config }) => {}
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
          config: {
            webhookUrl: param("webhook-url"),
          },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs[0]!.config).not.toHaveProperty("config");
    });

  });

});
