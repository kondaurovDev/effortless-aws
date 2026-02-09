import { describe, it, expect } from "vitest"

import { extractConfigs, extractTableConfigs } from "~/build/bundle"

describe("deps extraction", () => {

  describe("extractConfigs (HTTP)", () => {

    it("should extract shorthand deps keys", () => {
      const source = `
        import { defineHttp } from "effortless-aws";
        import { orders } from "./orders";

        export const createOrder = defineHttp({
          method: "POST",
          path: "/orders",
          deps: { orders },
          onRequest: async ({ req, deps }) => ({ status: 201 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should extract multiple deps keys", () => {
      const source = `
        import { defineHttp } from "effortless-aws";
        import { orders } from "./orders";
        import { users } from "./users";

        export const api = defineHttp({
          method: "POST",
          path: "/api",
          deps: { orders, users },
          onRequest: async ({ req, deps }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders", "users"]);
    });

    it("should extract explicit property assignment deps keys", () => {
      const source = `
        import { defineHttp } from "effortless-aws";
        import { orders } from "./orders";

        export const api = defineHttp({
          method: "POST",
          path: "/api",
          deps: { orders: orders },
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should return empty depsKeys when no deps property", () => {
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
      expect(configs[0]!.depsKeys).toEqual([]);
    });

    it("should extract deps from default export", () => {
      const source = `
        import { defineHttp } from "effortless-aws";
        import { orders } from "./orders";

        export default defineHttp({
          method: "POST",
          path: "/orders",
          deps: { orders },
          onRequest: async ({ req }) => ({ status: 201 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.depsKeys).toEqual(["orders"]);
    });

    it("should not leak deps into static config", () => {
      const source = `
        import { defineHttp } from "effortless-aws";
        import { orders } from "./orders";

        export const api = defineHttp({
          method: "POST",
          path: "/orders",
          deps: { orders },
          onRequest: async ({ req }) => ({ status: 201 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs[0]!.config).toEqual({ method: "POST", path: "/orders" });
      expect(configs[0]!.config).not.toHaveProperty("deps");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract deps keys from table handler", () => {
      const source = `
        import { defineTable } from "effortless-aws";
        import { users } from "./users";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          deps: { users },
          onRecord: async ({ record, deps }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.depsKeys).toEqual(["users"]);
    });

    it("should return empty depsKeys for table without deps", () => {
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
      expect(configs[0]!.depsKeys).toEqual([]);
    });

    it("should not leak deps into table static config", () => {
      const source = `
        import { defineTable } from "effortless-aws";
        import { users } from "./users";

        export const orders = defineTable({
          name: "orders",
          pk: { name: "id", type: "string" },
          deps: { users },
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs[0]!.config).not.toHaveProperty("deps");
      expect(configs[0]!.config.name).toBe("orders");
    });

  });

});
