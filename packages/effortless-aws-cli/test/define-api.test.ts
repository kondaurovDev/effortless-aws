import { describe, it, expect } from "vitest"
import * as path from "path"

import { extractApiConfigs } from "./helpers/extract-from-source"
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

    it("should extract basePath from config", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/users", async ({ req }) => ({ status: 200, body: [] }));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.config).toEqual({ basePath: "/api" });
    });

    it("should strip routes from static config", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const api = defineApi({ basePath: "/api" })
          .get("/users", async ({ req }) => ({ status: 200, body: [] }))
          .post("/users", async ({ input }) => ({ status: 201, body: input }));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("api");
      expect(configs[0]!.config).toEqual({ basePath: "/api" });
      expect(configs[0]!.config).not.toHaveProperty("routes");
    });

    it("should not match other define* calls", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const api = defineTable({ schema: (input) => input }).build();
      `;

      const configs = await extractApiConfigs(source);
      expect(configs).toHaveLength(0);
    });

    it("should extract deps and param entries", async () => {
      const source = `
        import { defineApi } from "effortless-aws";
        const users = {} as any;

        export default defineApi({ basePath: "/api" })
          .deps(() => ({ users }))
          .config(({ defineSecret }) => ({ dbUrl: defineSecret({ key: "database-url" }) }))
          .get("/users", async ({ req }) => ({ status: 200, body: [] }));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.depsKeys).toEqual(["users"]);
      expect(configs[0]!.secretEntries).toEqual([{ propName: "dbUrl", ssmKey: "database-url" }]);
    });

  });

  describe("route matching", () => {

    it("should route GET requests by path", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/users", async ({ req }) => ({ status: 200, body: { route: "list-users" } }))
          .get("/health", async ({ req }) => ({ status: 200, body: { route: "health" } }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res1 = await mod.handler(makeEvent("GET", "/api/users"));
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).route).toBe("list-users");

      const res2 = await mod.handler(makeEvent("GET", "/api/health"));
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).route).toBe("health");
    });

    it("should pass merged input via input arg", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/user", async ({ req }) => ({ status: 200, body: { userId: req.query.id } }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("GET", "/api/user", {
        queryStringParameters: { id: "123" },
      }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).userId).toBe("123");
    });

    it("should validate input with schema function", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/user", async ({ input }) => {
            if (!input || !input.id) throw new Error("id is required");
            const data = { id: input.id };
            return { status: 200, body: { userId: data.id } };
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res1 = await mod.handler(makeEvent("GET", "/api/user", {
        queryStringParameters: { id: "123" },
      }));
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).userId).toBe("123");

      const res2 = await mod.handler(makeEvent("GET", "/api/user"));
      expect(res2.statusCode).toBe(500);
    });

    it("should return 404 for unmatched path", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/users", async () => ({ status: 200, body: [] }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("GET", "/api/unknown"));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe("Not Found");
    });

  });

  describe("POST routes", () => {

    it("should validate body and pass data to handler", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .post("/users", async ({ input }) => {
            if (!input || typeof input !== "object" || !("name" in input)) {
              throw new Error("name is required");
            }
            return { status: 201, body: { created: input.name } };
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api/users", {
        body: JSON.stringify({ name: "Alice" })
      }));

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).created).toBe("Alice");
    });

    it("should return 500 when validation throws", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .post("/users", async ({ input }) => {
            if (!input || typeof input !== "object" || !("name" in input)) {
              throw new Error("name is required");
            }
            return { status: 201, body: input };
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api/users", {
        body: JSON.stringify({ noName: true })
      }));

      expect(res.statusCode).toBe(500);
    });

    it("should return 404 for POST when route not found", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/users", async () => ({ status: 200, body: [] }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("POST", "/api/users", {
        body: JSON.stringify({ name: "test" })
      }));

      expect(res.statusCode).toBe(404);
    });

  });

  describe("setup", () => {

    it("should pass setup result to route handlers", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .setup(() => ({ db: "mock-client" }))
          .get("/data", async ({ db }) => ({ status: 200, body: { client: db } }))
          .post("/data", async ({ input, db }) => {
            return { status: 200, body: { client: db, data: input } };
          });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const getRes = await mod.handler(makeEvent("GET", "/api/data"));
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body).client).toBe("mock-client");

      const postRes = await mod.handler(makeEvent("POST", "/api/data", {
        body: JSON.stringify({ action: "test" })
      }));
      expect(postRes.statusCode).toBe(200);
      expect(JSON.parse(postRes.body).client).toBe("mock-client");
    });

  });

  describe("methods", () => {

    it("should return 404 for unsupported methods", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/users", async () => ({ status: 200, body: [] }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });

      const res = await mod.handler(makeEvent("PUT", "/api/users"));
      expect(res.statusCode).toBe(404);
    });

  });

  describe("cache", () => {

    it("should set Cache-Control header from shorthand duration", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/data", async () => ({ status: 200, body: { ok: true } }), { cache: "30s" });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });
      const res = await mod.handler(makeEvent("GET", "/api/data"));

      expect(res.statusCode).toBe(200);
      expect(res.headers["Cache-Control"]).toBe("public, max-age=30, s-maxage=30, stale-while-revalidate=60");
    });

    it("should set Cache-Control from object with custom swr", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/data", async () => ({ status: 200, body: {} }), { cache: { ttl: "1m", swr: "5m" } });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });
      const res = await mod.handler(makeEvent("GET", "/api/data"));

      expect(res.headers["Cache-Control"]).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    });

    it("should set private Cache-Control for scope private", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/me", async () => ({ status: 200, body: {} }), { cache: { ttl: "10s", scope: "private" } });
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });
      const res = await mod.handler(makeEvent("GET", "/api/me"));

      expect(res.headers["Cache-Control"]).toBe("private, max-age=10");
    });

    it("should not set Cache-Control on routes without cache option", async () => {
      const handlerCode = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/api" })
          .get("/data", async () => ({ status: 200, body: {} }));
      `;

      const mod = await importBundle({ code: handlerCode, projectDir, type: "api" });
      const res = await mod.handler(makeEvent("GET", "/api/data"));

      expect(res.headers["Cache-Control"]).toBeUndefined();
    });

  });

});
