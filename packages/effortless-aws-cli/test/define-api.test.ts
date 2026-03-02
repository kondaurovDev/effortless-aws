import { describe, it, expect } from "vitest"
import * as path from "path"

import { extractApiConfigs } from "~cli/build/bundle"
import { importBundle } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

const makeEvent = (method: string, eventPath: string, overrides: Record<string, unknown> = {}) => ({
  requestContext: { http: { method, path: eventPath } },
  headers: {},
  queryStringParameters: {},
  pathParameters: {},
  body: null,
  ...overrides,
});

describe("defineApi", () => {

  describe("AST extraction", () => {

    it("should extract basePath from config", () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
          post: async ({ data }) => ({ status: 200, body: data }),
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.config).toEqual({ basePath: "/api" });
    });

    it("should strip get, post, schema from static config", () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi({
          basePath: "/api",
          memory: 512,
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
          schema: (input) => input,
          post: async ({ data }) => ({ status: 200, body: data }),
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("api");
      expect(configs[0]!.config).toEqual({ basePath: "/api", memory: 512 });
      expect(configs[0]!.config).not.toHaveProperty("get");
      expect(configs[0]!.config).not.toHaveProperty("post");
      expect(configs[0]!.config).not.toHaveProperty("schema");
    });

    it("should not match defineHttp calls", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const api = defineHttp({
          method: "GET",
          path: "/api",
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractApiConfigs(source);
      expect(configs).toHaveLength(0);
    });

    it("should extract deps and param entries", () => {
      const source = `
        import { defineApi, param } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          deps: { users },
          config: { dbUrl: param("database-url") },
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
        });
      `;

      const configs = extractApiConfigs(source);

      expect(configs[0]!.depsKeys).toEqual(["users"]);
      expect(configs[0]!.paramEntries).toEqual([{ propName: "dbUrl", ssmKey: "database-url" }]);
    });

  });

  describe("GET routing", () => {

    it("should route GET requests by path", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users": async ({ req }) => ({
              status: 200,
              body: { route: "list-users" }
            }),
            "/health": async ({ req }) => ({
              status: 200,
              body: { route: "health" }
            }),
          },
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res1 = await mod.handler(makeEvent("GET", "/api/users"));
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).route).toBe("list-users");

      const res2 = await mod.handler(makeEvent("GET", "/api/health"));
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).route).toBe("health");
    });

    it("should extract path parameters", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users/{id}": async ({ req }) => ({
              status: 200,
              body: { userId: req.params.id }
            }),
            "/users/{userId}/posts/{postId}": async ({ req }) => ({
              status: 200,
              body: { userId: req.params.userId, postId: req.params.postId }
            }),
          },
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res1 = await mod.handler(makeEvent("GET", "/api/users/123"));
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).userId).toBe("123");

      const res2 = await mod.handler(makeEvent("GET", "/api/users/456/posts/789"));
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.userId).toBe("456");
      expect(body2.postId).toBe("789");
    });

    it("should return 404 for unmatched GET path", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("GET", "/api/unknown"));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe("Not Found");
    });

  });

  describe("POST handling", () => {

    it("should validate body with schema and pass data to handler", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          schema: (input) => {
            const obj = input;
            if (!obj || typeof obj !== "object" || !("action" in obj)) {
              throw new Error("action is required");
            }
            return obj;
          },
          post: async ({ data }) => ({
            status: 200,
            body: { received: data.action }
          }),
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api", {
        body: JSON.stringify({ action: "createUser", name: "Alice" })
      }));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).received).toBe("createUser");
    });

    it("should return 400 when schema validation fails", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          schema: (input) => {
            if (!input || typeof input !== "object" || !("action" in input)) {
              throw new Error("action is required");
            }
            return input;
          },
          post: async ({ data }) => ({ status: 200, body: data }),
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api", {
        body: JSON.stringify({ noAction: true })
      }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Validation failed");
    });

    it("should return 404 for POST when no post handler defined", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api", {
        body: JSON.stringify({ action: "test" })
      }));

      expect(res.statusCode).toBe(404);
    });

  });

  describe("setup", () => {

    it("should pass setup result to GET and POST handlers", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          setup: () => ({ db: "mock-client" }),
          get: {
            "/data": async ({ req, ctx }) => ({
              status: 200,
              body: { client: ctx.db }
            }),
          },
          schema: (input) => input,
          post: async ({ data, ctx }) => ({
            status: 200,
            body: { client: ctx.db, data }
          }),
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const getRes = await mod.handler(makeEvent("GET", "/api/data"));
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body).client).toBe("mock-client");

      const postRes = await mod.handler(makeEvent("POST", "/api", {
        body: JSON.stringify({ action: "test" })
      }));
      expect(postRes.statusCode).toBe(200);
      expect(JSON.parse(postRes.body).client).toBe("mock-client");
    });

  });

  describe("methods", () => {

    it("should return 404 for unsupported methods (PUT, DELETE, etc.)", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({
          basePath: "/api",
          get: {
            "/users": async ({ req }) => ({ status: 200, body: [] }),
          },
          schema: (input) => input,
          post: async ({ data }) => ({ status: 200, body: data }),
        });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("PUT", "/api/users"));
      expect(res.statusCode).toBe(404);
    });

  });

});
