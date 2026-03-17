import { describe, it, expect } from "vitest"

import { extractApiConfigs, extractTableConfigs } from "./helpers/extract-from-source"

describe("params extraction", () => {

  describe("extractApiConfigs", () => {

    it("should extract param entries from handler", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            dbUrl: defineSecret({ key: "database-url" }),
          }),
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should extract multiple param entries", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            dbUrl: defineSecret({ key: "database-url" }),
            apiKey: defineSecret({ key: "stripe-api-key" }),
          }),
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" },
        { propName: "apiKey", ssmKey: "stripe-api-key" }
      ]);
    });

    it("should extract param entries with transform", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        import TOML from "smol-toml";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            appConfig: defineSecret({ key: "app-config" }),
          }),
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([
        { propName: "appConfig", ssmKey: "app-config" }
      ]);
    });

    it("should return empty secretEntries when no params property", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const hello = defineApi()({
          basePath: "/hello",
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([]);
    });

    it("should extract params from default export", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export default defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            dbUrl: defineSecret({ key: "database-url" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.secretEntries).toEqual([
        { propName: "dbUrl", ssmKey: "database-url" }
      ]);
    });

    it("should not leak params into static config", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            dbUrl: defineSecret({ key: "database-url" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.config).toEqual({ basePath: "/orders" });
      expect(configs[0]!.config).not.toHaveProperty("config");
    });

  });

  describe("secret() extraction", () => {

    it("should derive SSM key from property name (camelCase → kebab-case)", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            authSecret: defineSecret(),
            dbUrl: defineSecret(),
          }),
          get: { "/": async ({ req, config }) => ({ status: 200 }) }
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "authSecret", ssmKey: "auth-secret" },
        { propName: "dbUrl", ssmKey: "db-url" },
      ]);
    });

    it("should use explicit key when provided", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            dbUrl: defineSecret({ key: "my-custom-key" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "dbUrl", ssmKey: "my-custom-key" },
      ]);
    });

    it("should extract generate spec for generateHex", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            authSecret: defineSecret({ generate: "hex:32" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "authSecret", ssmKey: "auth-secret", generate: "hex:32" },
      ]);
    });

    it("should extract generate spec for generateBase64", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            token: defineSecret({ generate: "base64:16" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "token", ssmKey: "token", generate: "base64:16" },
      ]);
    });

    it("should extract generate spec for generateUuid", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            instanceId: defineSecret({ generate: "uuid" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "instanceId", ssmKey: "instance-id", generate: "uuid" },
      ]);
    });

    it("should support secret with key + generate together", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi()({
          basePath: "/orders",
          config: ({ defineSecret }) => ({
            hmacKey: defineSecret({ key: "hmac-secret", generate: "hex:64" }),
          }),
          routes: []
        });
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.secretEntries).toEqual([
        { propName: "hmacKey", ssmKey: "hmac-secret", generate: "hex:64" },
      ]);
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract param entries from table handler", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()({
          name: "orders",
          config: ({ defineSecret }) => ({
            webhookUrl: defineSecret({ key: "webhook-url" }),
          }),
          onRecord: async ({ record, config }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([
        { propName: "webhookUrl", ssmKey: "webhook-url" }
      ]);
    });

    it("should return empty secretEntries for table without params", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()({
          name: "orders",
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.secretEntries).toEqual([]);
    });

    it("should not leak params into table static config", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()({
          config: ({ defineSecret }) => ({
            webhookUrl: defineSecret({ key: "webhook-url" }),
          }),
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = await extractTableConfigs(source);

      expect(configs[0]!.config).not.toHaveProperty("config");
    });

  });

});
