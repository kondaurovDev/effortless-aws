import { describe, it, expect } from "vitest"
import * as path from "path"

import { extractConfigs } from "~/build/bundle"
import { importBundle } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

const makeEvent = (overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST", path: "/test" } },
  headers: {},
  queryStringParameters: {},
  pathParameters: {},
  body: null,
  ...overrides,
});

describe("defineHttp", () => {

  it("should bundle and invoke handler", async () => {
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

    const mod = await importBundle({ code: handlerCode, projectDir });

    expect(typeof mod.handler).toBe("function");

    const response = await mod.handler({
      requestContext: { http: { method: "GET", path: "/hello" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe("Hello /hello");
  });

  it("should pass context to handler", async () => {
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

    const mod = await importBundle({ code: handlerCode, projectDir });

    const response = await mod.handler({
      requestContext: { http: { method: "GET", path: "/test" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.client).toBe("mock-client");
    expect(body.ready).toBe(true);
  });

  describe("schema", () => {

    it("should validate body and pass data to handler", async () => {
      const handlerCode = `
        import { defineHttp } from "./src/handlers/define-http";

        export default defineHttp({
          method: "POST",
          path: "/users",
          schema: (input) => {
            const obj = input;
            if (!obj || typeof obj !== "object" || !("name" in obj) || typeof obj.name !== "string") {
              throw new Error("name is required and must be a string");
            }
            return { name: obj.name };
          },
          onRequest: async ({ data }) => ({
            status: 201,
            body: { created: data.name }
          })
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir });

      const response = await mod.handler(makeEvent({
        body: JSON.stringify({ name: "Alice" })
      }));

      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).created).toBe("Alice");
    });

    it("should return 400 when validation fails", async () => {
      const handlerCode = `
        import { defineHttp } from "./src/handlers/define-http";

        export default defineHttp({
          method: "POST",
          path: "/users",
          schema: (input) => {
            const obj = input;
            if (!obj || typeof obj !== "object" || !("name" in obj)) {
              throw new Error("name is required");
            }
            return { name: obj.name };
          },
          onRequest: async ({ data }) => ({
            status: 201,
            body: data
          })
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir });

      const response = await mod.handler(makeEvent({
        body: JSON.stringify({ age: 25 })
      }));

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toContain("name is required");
    });

    it("should work together with context", async () => {
      const handlerCode = `
        import { defineHttp } from "./src/handlers/define-http";

        export default defineHttp({
          method: "POST",
          path: "/orders",
          schema: (input) => {
            const obj = input;
            if (!obj || typeof obj !== "object" || !("item" in obj)) {
              throw new Error("item is required");
            }
            return { item: obj.item };
          },
          context: () => ({ store: "mock-store" }),
          onRequest: async ({ data, ctx }) => ({
            status: 201,
            body: { item: data.item, store: ctx.store }
          })
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir });

      const response = await mod.handler(makeEvent({
        body: JSON.stringify({ item: "book" })
      }));

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.item).toBe("book");
      expect(body.store).toBe("mock-store");
    });

    it("should not leak schema into static config", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const createUser = defineHttp({
          method: "POST",
          path: "/users",
          schema: (input) => input,
          onRequest: async ({ data }) => ({ status: 200, body: data })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.config).toEqual({ method: "POST", path: "/users" });
      expect(configs[0]!.config).not.toHaveProperty("schema");
    });

  });

});
