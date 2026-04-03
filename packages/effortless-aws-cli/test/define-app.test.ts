import { describe, it, expect } from "vitest"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { extractAppConfigs } from "./helpers/extract-from-source"
import { detectAssetPatterns, zipDirectory } from "~cli/build/bundle"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"

const run = <A>(effect: Effect.Effect<A, any, any>) =>
  Effect.runPromise(Effect.provide(effect, NodeContext.layer) as Effect.Effect<A>)

// ============ AST extraction ============

describe("defineApp extraction", () => {

  it("should extract app config from named export", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("app");
    expect(configs[0]!.config).toEqual({
      server: ".output/server",
      assets: ".output/public",
    });
  });

  it("should extract app config from default export", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export default defineApp()({
        server: ".output/server",
        assets: ".output/public",
        path: "/",
        timeout: 30,
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("default");
    expect(configs[0]!.config).toEqual({
      server: ".output/server",
      assets: ".output/public",
      path: "/",
      timeout: 30,
    });
  });

  it("should preserve server, assets, and domain in config", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
        domain: "app.example.com",
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs[0]!.config).toHaveProperty("server", ".output/server");
    expect(configs[0]!.config).toHaveProperty("assets", ".output/public");
    expect(configs[0]!.config).toHaveProperty("domain", "app.example.com");
  });

  it("should extract build command in config", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
        build: "nuxt build",
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs[0]!.config).toHaveProperty("build", "nuxt build");
  });

  it("should extract memory and permissions", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
        memory: 1024,
        permissions: ["s3:GetObject"],
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs[0]!.config).toHaveProperty("memory", 1024);
    expect(configs[0]!.config).toHaveProperty("permissions");
    expect((configs[0]!.config as any).permissions).toEqual(["s3:GetObject"]);
  });

  it("should extract stage-keyed domain config", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
        domain: { prod: "app.example.com", staging: "staging.example.com" },
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs[0]!.config).toHaveProperty("domain");
    expect((configs[0]!.config as any).domain).toEqual({
      prod: "app.example.com",
      staging: "staging.example.com",
    });
  });

  it("should have empty deps, params, and static globs", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        server: ".output/server",
        assets: ".output/public",
      });
    `;

    const configs = await extractAppConfigs(source);

    expect(configs[0]!.depsKeys).toEqual([]);
    expect(configs[0]!.secretEntries).toEqual([]);
    expect(configs[0]!.staticGlobs).toEqual([]);
  });

  it("should not match defineStaticSite calls", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite()({
        dir: "dist",
        build: "npm run build",
      });
    `;

    const configs = await extractAppConfigs(source);
    expect(configs).toHaveLength(0);
  });

  it("should not match other define* calls", async () => {
    const source = `
      import { defineApi } from "effortless-aws";

      export const api = defineApi({ basePath: "/api" })
        .get({ path: "/" }, async ({ req }) => ({ status: 200 }));
    `;

    const configs = await extractAppConfigs(source);
    expect(configs).toHaveLength(0);
  });

});

// ============ detectAssetPatterns ============

describe("detectAssetPatterns", () => {

  it("should detect directories as /{name}/* and files as /{name}", async () => {
    const fixtureDir = path.resolve(__dirname, "fixtures/site");
    const patterns = await run(detectAssetPatterns(fixtureDir));

    // The fixtures/site dir has: app.js, assets/, index.html, style.css
    expect(patterns).toContain("/assets/*");
    expect(patterns).toContain("/app.js");
    expect(patterns).toContain("/index.html");
    expect(patterns).toContain("/style.css");
  });

  it("should return empty array for non-existent directory", async () => {
    const patterns = await run(detectAssetPatterns("/tmp/nonexistent-dir-" + Date.now()));
    expect(patterns).toEqual([]);
  });

  it("should handle empty directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eff-test-"));
    try {
      const patterns = await run(detectAssetPatterns(tmpDir));
      expect(patterns).toEqual([]);
    } finally {
      fs.rmdirSync(tmpDir);
    }
  });

});

// ============ zipDirectory ============

describe("zipDirectory", () => {

  it("should produce a non-empty buffer from a directory", async () => {
    const fixtureDir = path.resolve(__dirname, "fixtures/site");
    const buffer = await Effect.runPromise(zipDirectory(fixtureDir));

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    // ZIP magic bytes
    expect(buffer[0]).toBe(0x50); // P
    expect(buffer[1]).toBe(0x4b); // K
  });

});
