import { describe, it, expect } from "vitest"
import * as path from "path"

import { extractSiteConfigs } from "~/build/bundle"
import { buildSiteRoutePaths } from "~/deploy/deploy"
import { importBundle } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

const makeEvent = (file?: string) => ({
  requestContext: { http: { method: "GET", path: file ? `/app/${file}` : "/app" } },
  headers: {},
  queryStringParameters: {},
  pathParameters: file ? { file } : {},
  body: null,
});

// ============ AST extraction ============

describe("defineSite extraction", () => {

  it("should extract site config from named export", () => {
    const source = `
      import { defineSite } from "effortless-aws";

      export const app = defineSite({
        path: "/app",
        dir: "src/webapp",
      });
    `;

    const configs = extractSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("app");
    expect(configs[0]!.config).toEqual({ path: "/app", dir: "src/webapp" });
  });

  it("should extract site config from default export", () => {
    const source = `
      import { defineSite } from "effortless-aws";

      export default defineSite({
        name: "webapp",
        path: "/",
        dir: "dist",
        spa: true,
        timeout: 10,
      });
    `;

    const configs = extractSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("default");
    expect(configs[0]!.config).toEqual({
      name: "webapp",
      path: "/",
      dir: "dist",
      spa: true,
      timeout: 10,
    });
  });

  it("should preserve dir, index, and spa in config (not stripped as runtime props)", () => {
    const source = `
      import { defineSite } from "effortless-aws";

      export const app = defineSite({
        path: "/app",
        dir: "public",
        index: "main.html",
        spa: true,
      });
    `;

    const configs = extractSiteConfigs(source);

    expect(configs[0]!.config).toHaveProperty("dir", "public");
    expect(configs[0]!.config).toHaveProperty("index", "main.html");
    expect(configs[0]!.config).toHaveProperty("spa", true);
  });

  it("should have empty deps, params, and static globs", () => {
    const source = `
      import { defineSite } from "effortless-aws";

      export const app = defineSite({
        path: "/app",
        dir: "src/webapp",
      });
    `;

    const configs = extractSiteConfigs(source);

    expect(configs[0]!.depsKeys).toEqual([]);
    expect(configs[0]!.paramEntries).toEqual([]);
    expect(configs[0]!.staticGlobs).toEqual([]);
  });

  it("should extract build command in config", () => {
    const source = `
      import { defineSite } from "effortless-aws";

      export const app = defineSite({
        path: "/app",
        dir: "dist",
        build: "npx astro build",
      });
    `;

    const configs = extractSiteConfigs(source);

    expect(configs[0]!.config).toHaveProperty("build", "npx astro build");
  });

  it("should not match defineHttp or defineTable calls", () => {
    const source = `
      import { defineHttp } from "effortless-aws";

      export const api = defineHttp({
        method: "GET",
        path: "/api",
        onRequest: async ({ req }) => ({ status: 200 })
      });
    `;

    const configs = extractSiteConfigs(source);
    expect(configs).toHaveLength(0);
  });

});

// ============ Route path resolution ============

describe("buildSiteRoutePaths", () => {

  it("root path: / → GET / and GET /{file+}", () => {
    const [root, greedy] = buildSiteRoutePaths("/");
    expect(root).toBe("/");
    expect(greedy).toBe("/{file+}");
  });

  it("subpath: /app → GET /app and GET /app/{file+}", () => {
    const [root, greedy] = buildSiteRoutePaths("/app");
    expect(root).toBe("/app");
    expect(greedy).toBe("/app/{file+}");
  });

  it("trailing slash: /app/ → GET /app and GET /app/{file+}", () => {
    const [root, greedy] = buildSiteRoutePaths("/app/");
    expect(root).toBe("/app");
    expect(greedy).toBe("/app/{file+}");
  });

  it("nested path: /docs/v2 → GET /docs/v2 and GET /docs/v2/{file+}", () => {
    const [root, greedy] = buildSiteRoutePaths("/docs/v2");
    expect(root).toBe("/docs/v2");
    expect(greedy).toBe("/docs/v2/{file+}");
  });

  it("no double slashes in greedy path for root", () => {
    const [, greedy] = buildSiteRoutePaths("/");
    expect(greedy).not.toContain("//");
  });

});

// ============ Runtime ============

describe("wrapSite runtime", () => {

  it("should serve index.html at root path", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent());

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("<h1>Hello Site</h1>");
  });

  it("should serve CSS with correct content-type", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("style.css"));

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/css; charset=utf-8");
    expect(response.body).toContain("body { color: red; }");
  });

  it("should serve JS with correct content-type", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("app.js"));

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("application/javascript; charset=utf-8");
    expect(response.body).toContain("console.log");
  });

  it("should return 404 for missing files", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("nonexistent.html"));

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("404");
  });

  it("should block path traversal", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("../../package.json"));

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("403");
  });

  it("should serve index.html in SPA mode for non-file paths", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
        spa: true,
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("dashboard/settings"));

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("<h1>Hello Site</h1>");
  });

  it("should return 404 in non-SPA mode for non-file paths", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });
    const response = await mod.handler(makeEvent("dashboard/settings"));

    expect(response.statusCode).toBe(404);
  });

  it("should set cache-control headers", async () => {
    const handlerCode = `
      import { defineSite } from "./src/handlers/define-site";

      export default defineSite({
        path: "/app",
        dir: "test/fixtures/site",
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir, type: "site" });

    const htmlRes = await mod.handler(makeEvent("index.html"));
    expect(htmlRes.headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");

    const cssRes = await mod.handler(makeEvent("style.css"));
    expect(cssRes.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

});
