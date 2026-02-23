import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as path from "path"
import * as AdmZip from "adm-zip"

import { extractConfigs, extractTableConfigs } from "~/build/bundle"
import { zip, resolveStaticFiles } from "~/build/bundle"
import { importBundle, bundleCode } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

// ============ AST extraction ============

describe("static extraction", () => {

  describe("extractConfigs (HTTP)", () => {

    it("should extract static globs", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const widget = defineHttp({
          method: "GET",
          path: "/widget",
          static: ["src/templates/*.ejs"],
          onRequest: async ({ req, files }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/*.ejs"]);
    });

    it("should extract multiple static globs", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const widget = defineHttp({
          method: "GET",
          path: "/widget",
          static: ["src/templates/*.ejs", "src/assets/*.css"],
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/*.ejs", "src/assets/*.css"]);
    });

    it("should return empty staticGlobs when no static property", () => {
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
      expect(configs[0]!.staticGlobs).toEqual([]);
    });

    it("should extract static from default export", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export default defineHttp({
          method: "GET",
          path: "/widget",
          static: ["templates/*.ejs"],
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.staticGlobs).toEqual(["templates/*.ejs"]);
    });

    it("should not leak static into config", () => {
      const source = `
        import { defineHttp } from "effortless-aws";

        export const widget = defineHttp({
          method: "GET",
          path: "/widget",
          static: ["src/templates/*.ejs"],
          onRequest: async ({ req }) => ({ status: 200 })
        });
      `;

      const configs = extractConfigs(source);

      expect(configs[0]!.config).toEqual({ method: "GET", path: "/widget" });
      expect(configs[0]!.config).not.toHaveProperty("static");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract static globs from table handler", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          static: ["src/templates/report.ejs"],
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/report.ejs"]);
    });

    it("should return empty staticGlobs for table without static", () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({
          name: "orders",
          onRecord: async ({ record }) => {}
        });
      `;

      const configs = extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual([]);
    });

  });

});

// ============ resolveStaticFiles ============

describe("resolveStaticFiles", () => {

  it("should resolve glob to actual files", () => {
    const files = resolveStaticFiles(["test/fixtures/*.txt"], projectDir);

    expect(files).toHaveLength(1);
    expect(files[0]!.zipPath).toBe("test/fixtures/hello.txt");
    expect(files[0]!.content.toString("utf-8")).toBe("Hello from static file!");
  });

  it("should return empty array for non-matching glob", () => {
    const files = resolveStaticFiles(["test/fixtures/*.xyz"], projectDir);
    expect(files).toHaveLength(0);
  });

  it("should resolve recursive glob skipping directories", () => {
    const files = resolveStaticFiles(["test/fixtures/site/**/*"], projectDir);

    const paths = files.map(f => f.zipPath).sort();

    // must contain files from root and nested assets/ dir
    expect(paths).toContain("test/fixtures/site/index.html");
    expect(paths).toContain("test/fixtures/site/app.js");
    expect(paths).toContain("test/fixtures/site/style.css");
    expect(paths).toContain("test/fixtures/site/assets/main.css");
    expect(paths).toContain("test/fixtures/site/assets/main.js");

    // must NOT contain the directory itself
    expect(paths).not.toContain("test/fixtures/site/assets");

    // every entry must be a readable Buffer
    for (const f of files) {
      expect(Buffer.isBuffer(f.content)).toBe(true);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

});

// ============ zip with static files ============

describe("zip with static files", () => {

  it("should include static files in zip archive", async () => {
    const staticFiles = resolveStaticFiles(["test/fixtures/*.txt"], projectDir);
    const zipBuffer = await Effect.runPromise(zip({
      content: "export const handler = () => {};",
      staticFiles
    }));

    const archive = new AdmZip.default(zipBuffer);
    const entries = archive.getEntries().map(e => e.entryName);

    expect(entries).toContain("index.mjs");
    expect(entries).toContain("test/fixtures/hello.txt");

    const content = archive.readAsText("test/fixtures/hello.txt");
    expect(content).toBe("Hello from static file!");
  });

  it("should produce valid zip without static files", async () => {
    const zipBuffer = await Effect.runPromise(zip({
      content: "export const handler = () => {};",
    }));

    const archive = new AdmZip.default(zipBuffer);
    const entries = archive.getEntries().map(e => e.entryName);

    expect(entries).toContain("index.mjs");
    expect(entries).toHaveLength(1);
  });

});

// ============ end-to-end: handler reads static file ============

describe("static files runtime", () => {

  it("should inject files service and read bundled file", async () => {
    const handlerCode = `
      import { defineHttp } from "./src/handlers/define-http";

      export default defineHttp({
        method: "GET",
        path: "/widget",
        static: ["test/fixtures/hello.txt"],
        onRequest: async ({ req, files }) => ({
          status: 200,
          body: { content: files.read("test/fixtures/hello.txt") }
        })
      });
    `;

    const mod = await importBundle({ code: handlerCode, projectDir });

    const response = await mod.handler({
      requestContext: { http: { method: "GET", path: "/widget" } },
      headers: {},
      queryStringParameters: {},
      pathParameters: {},
      body: null
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.content).toBe("Hello from static file!");
  });

});
