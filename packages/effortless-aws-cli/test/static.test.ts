import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as path from "path"
import * as AdmZip from "adm-zip"

import { extractApiConfigs, extractTableConfigs } from "./helpers/extract-from-source"
import { zip, resolveStaticFiles } from "~cli/build/bundle"
import { importBundle, bundleCode } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

// ============ AST extraction ============

describe("static extraction", () => {

  describe("extractApiConfigs", () => {

    it("should extract static globs", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const widget = defineApi({ basePath: "/widget", static: ["src/templates/*.ejs"] }).get("/", () => ({}));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/*.ejs"]);
    });

    it("should extract multiple static globs", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const widget = defineApi({ basePath: "/widget", static: ["src/templates/*.ejs", "src/assets/*.css"] }).get("/", () => ({}));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/*.ejs", "src/assets/*.css"]);
    });

    it("should return empty staticGlobs when no static property", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const hello = defineApi({ basePath: "/hello" }).get("/", () => ({}));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual([]);
    });

    it("should extract static from default export", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export default defineApi({ basePath: "/widget", static: ["templates/*.ejs"] }).get("/", () => ({}));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.exportName).toBe("default");
      expect(configs[0]!.staticGlobs).toEqual(["templates/*.ejs"]);
    });

    it("should not leak static into config", async () => {
      const source = `
        import { defineApi } from "effortless-aws";

        export const widget = defineApi({ basePath: "/widget", static: ["src/templates/*.ejs"] }).get("/", () => ({}));
      `;

      const configs = await extractApiConfigs(source);

      expect(configs[0]!.config).toEqual({ basePath: "/widget" });
      expect(configs[0]!.config).not.toHaveProperty("static");
    });

  });

  describe("extractTableConfigs", () => {

    it("should extract static globs from table handler", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable({ static: ["src/templates/report.ejs"] })
          .onRecord(async ({ record }) => {});
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual(["src/templates/report.ejs"]);
    });

    it("should return empty staticGlobs for table without static", async () => {
      const source = `
        import { defineTable } from "effortless-aws";

        export const orders = defineTable()
          .onRecord(async ({ record }) => {});
      `;

      const configs = await extractTableConfigs(source);

      expect(configs).toHaveLength(1);
      expect(configs[0]!.staticGlobs).toEqual([]);
    });

  });

});

// ============ resolveStaticFiles ============

describe("resolveStaticFiles", () => {

  it("should resolve a file path", () => {
    const { files, missing } = resolveStaticFiles(["test/fixtures/hello.txt"], projectDir);

    expect(files).toHaveLength(1);
    expect(files[0]!.zipPath).toBe("test/fixtures/hello.txt");
    expect(files[0]!.content.toString("utf-8")).toBe("Hello from static file!");
    expect(missing).toHaveLength(0);
  });

  it("should report missing paths", () => {
    const { files, missing } = resolveStaticFiles(["test/fixtures/nope.xyz"], projectDir);
    expect(files).toHaveLength(0);
    expect(missing).toEqual(["test/fixtures/nope.xyz"]);
  });

  it("should resolve directory recursively, skipping subdirectory entries", () => {
    const { files, missing } = resolveStaticFiles(["test/fixtures/site"], projectDir);

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
    expect(missing).toHaveLength(0);
  });

  it("should strip leading slash from paths", () => {
    const { files } = resolveStaticFiles(["/test/fixtures/hello.txt"], projectDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.zipPath).toBe("test/fixtures/hello.txt");
  });

});

// ============ zip with static files ============

describe("zip with static files", () => {

  it("should include static files in zip archive", async () => {
    const { files: staticFiles } = resolveStaticFiles(["test/fixtures/hello.txt"], projectDir);
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
      import { defineApi } from "effortless-aws";

      export default defineApi({ basePath: "/widget", static: ["test/fixtures/hello.txt"] })
          .get("/index", async ({ files }) => ({
            status: 200,
            body: { content: files.read("test/fixtures/hello.txt") }
          }));
    `;

    const mod = await importBundle({ code: handlerCode, projectDir });

    const response = await mod.handler({
      requestContext: { http: { method: "GET", path: "/widget/index" } },
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
