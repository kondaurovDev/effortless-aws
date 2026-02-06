import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as path from "path"

import { zip, extractTableConfigs } from "~/build/bundle"
import { bundleCode } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

describe("bundle", () => {

  it("should bundle defineHttp handler", async () => {
    const handlerCode = `
      import { defineHttp } from "./src/handlers/define-http";

      export default defineHttp({
        name: "test-api",
        method: "GET",
        path: "/hello",
        onRequest: async ({ req }) => ({
          status: 200,
          body: { message: "Hello " + req.path }
        })
      });
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir }));

    // Should contain wrapHttp from runtime
    expect(result).toContain("wrapHttp");

    const dataUrl = `data:text/javascript;base64,${Buffer.from(result).toString("base64")}`;
    const mod = await import(dataUrl);

    // handler is exported
    expect(typeof mod.handler).toBe("function");

    // Test with API Gateway event format
    const apiGatewayEvent = {
      requestContext: { http: { method: "GET", path: "/hello" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    };

    const response = await mod.handler(apiGatewayEvent);

    // Response is in API Gateway format
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe("Hello /hello");
  });

  it("should create valid zip archive", async () => {
    const handlerCode = `
      import { defineHttp } from "./src/handlers/define-http";

      export default defineHttp({
        method: "GET",
        path: "/zip-test",
        onRequest: async () => ({ status: 200, body: { ok: true } })
      });
    `;

    const bundled = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir }));
    const zipBuffer = await Effect.runPromise(zip({ content: bundled }));

    // ZIP file starts with PK signature (0x504B)
    expect(zipBuffer[0]).toBe(0x50); // P
    expect(zipBuffer[1]).toBe(0x4B); // K

    expect(zipBuffer.length).toBeGreaterThan(0);
  });

});

describe("defineTable bundle", () => {

  it("should extract defineTable config from named export", () => {
    const source = `
      import { defineTable } from "@effect-ak/effortless";

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
    expect(configs[0].exportName).toBe("orders");
    expect(configs[0].config.name).toBe("orders");
    expect(configs[0].config.pk).toEqual({ name: "id", type: "string" });
    expect(configs[0].config.sk).toEqual({ name: "createdAt", type: "number" });
    expect(configs[0].config.streamView).toBe("NEW_AND_OLD_IMAGES");
    expect(configs[0].config.batchSize).toBe(50);
    expect(configs[0].config.memory).toBe(512);
    expect(configs[0].hasHandler).toBe(true);
  });

  it("should extract defineTable config from default export", () => {
    const source = `
      import { defineTable } from "@effect-ak/effortless";

      export default defineTable({
        name: "users",
        pk: { name: "userId", type: "string" },
        onRecord: async ({ record }) => {}
      });
    `;

    const configs = extractTableConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0].exportName).toBe("default");
    expect(configs[0].config.name).toBe("users");
    expect(configs[0].config.pk).toEqual({ name: "userId", type: "string" });
    expect(configs[0].hasHandler).toBe(true);
  });

  it("should extract defineTable config without handler (resource only)", () => {
    const source = `
      import { defineTable } from "@effect-ak/effortless";

      export const users = defineTable({
        name: "users",
        pk: { name: "userId", type: "string" }
      });
    `;

    const configs = extractTableConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0].exportName).toBe("users");
    expect(configs[0].config.name).toBe("users");
    expect(configs[0].hasHandler).toBe(false);
  });

  it("should bundle defineTable handler with DynamoDB unmarshall", async () => {
    const handlerCode = `
      import { defineTable } from "./src/handlers/define-table";

      export default defineTable({
        name: "orders",
        pk: { name: "id", type: "string" },
        onRecord: async ({ record }) => {
          console.log(record.eventName, record.new);
        }
      });
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir, type: "table" }));

    // Should contain wrapTableStream from runtime
    expect(result).toContain("wrapTableStream");

    // Should contain unmarshall for DynamoDB
    expect(result).toContain("unmarshall");

    // Should export handler
    expect(result).toContain("handler");
  });

  it("should handle multiple defineTable exports", () => {
    const source = `
      import { defineTable } from "@effect-ak/effortless";

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

describe("context support", () => {

  it("should bundle defineHttp with context and lazy initialization", async () => {
    const handlerCode = `
      import { defineHttp } from "./src/handlers/define-http";

      export default defineHttp({
        method: "GET",
        path: "/test",
        context: () => ({ db: "mock-client", initialized: true }),
        onRequest: async ({ req, ctx }) => ({
          status: 200,
          body: { client: ctx.db, ready: ctx.initialized }
        })
      });
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir }));

    // Should contain wrapHttp from runtime
    expect(result).toContain("wrapHttp");

    const dataUrl = `data:text/javascript;base64,${Buffer.from(result).toString("base64")}`;
    const mod = await import(dataUrl);

    const event = {
      requestContext: { http: { method: "GET", path: "/test" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    };

    const response = await mod.handler(event);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.client).toBe("mock-client");
    expect(body.ready).toBe(true);
  });

  it("should bundle defineTable with context and lazy initialization", async () => {
    const handlerCode = `
      import { defineTable } from "./src/handlers/define-table";

      export default defineTable({
        name: "orders",
        pk: { name: "id", type: "string" },
        context: () => ({ runtime: "mock-runtime" }),
        onRecord: async ({ record, ctx }) => {
          console.log("Using runtime:", ctx.runtime);
        }
      });
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir, type: "table" }));

    // Should contain wrapTableStream from runtime
    expect(result).toContain("wrapTableStream");

    // Should contain unmarshall
    expect(result).toContain("unmarshall");
  });

  it("should work without context provided", async () => {
    const handlerCode = `
      import { defineHttp } from "./src/handlers/define-http";

      export default defineHttp({
        method: "GET",
        path: "/test",
        onRequest: async ({ req }) => ({
          status: 200,
          body: { ok: true }
        })
      });
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir }));

    // Should contain wrapHttp
    expect(result).toContain("wrapHttp");

    const dataUrl = `data:text/javascript;base64,${Buffer.from(result).toString("base64")}`;
    const mod = await import(dataUrl);

    const event = {
      requestContext: { http: { method: "GET", path: "/test" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    };

    const response = await mod.handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
  });

});
