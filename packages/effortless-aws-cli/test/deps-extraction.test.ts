import { describe, it, expect } from "vitest"

import { extractApiConfigs, extractTableConfigs } from "./helpers/extract-from-source"

describe("deps extraction", () => {

  describe("extractApiConfigs", () => {

    it("should extract shorthand deps keys", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const orders = {} as any;

        export const createOrder = defineApi()({
          basePath: "/orders",
          deps: () => ({ orders }),
          post: async ({ req, deps }) => ({ status: 201 })
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should extract multiple deps keys", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const orders = {} as any;
        const users = {} as any;

        export const api = defineApi()({
          basePath: "/api",
          deps: () => ({ orders, users }),
          post: async ({ req, deps }) => ({ status: 200 })
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders", "users"]);
    });

    it("should extract explicit property assignment deps keys", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const orders = {} as any;

        export const api = defineApi()({
          basePath: "/api",
          deps: () => ({ orders: orders }),
          post: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should return empty depsKeys when no deps property", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const hello = defineApi()({
          basePath: "/hello",
          queries: { index: async ({ input }) => ({ status: 200 }) }
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual([]);
    });

    it("should extract deps from default export", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const orders = {} as any;

        export default defineApi()({
          basePath: "/orders",
          deps: () => ({ orders }),
          post: async ({ req }) => ({ status: 201 })
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should not leak deps into static config", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const orders = {} as any;

        export const api = defineApi()({
          basePath: "/orders",
          deps: () => ({ orders }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.config).toEqual({ basePath: "/orders" });
      expect(configs[0]!.config).not.toHaveProperty("deps");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract deps keys from table handler", async () => {
      const source = `
        import { defineTable } from "effortless-aws";
        const users = {} as any;

        export const orders = defineTable()({
          deps: () => ({ users }),
          onRecord: async ({ record, deps }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["users"]);
    });

    it("should return empty depsKeys for table without deps", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()({
          name: "orders",
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual([]);
    });

    it("should not leak deps into table static config", async () => {
      const source = `
        import { defineTable } from "effortless-aws";
        const users = {} as any;

        export const orders = defineTable()({
          deps: () => ({ users }),
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs[0]!.config).not.toHaveProperty("deps");
    });

  });

});
