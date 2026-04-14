import { describe, it, expect } from "vitest"
import * as path from "path"
import { Effect } from "effect"
import { NodeContext } from "@effect/platform-node"
import { discoverHandlers } from "~cli/discovery"

import { resolveStaticSiteRoutes } from "~cli/discovery/extract"
import type { HandlerType } from "~cli/core/handler-types"

import { extractStaticSiteConfigs } from "./helpers/extract-from-source"

// ============ AST extraction ============

describe("defineStaticSite extraction", () => {

  it("should extract config from named export", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite({ dir: "dist", errorPage: "index.html", build: "npm run build" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("docs");
    expect(configs[0]!.config).toEqual({
      dir: "dist",
      errorPage: "index.html",
      build: "npm run build",
    });
  });

  it("should extract config from default export", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export default defineStaticSite({ dir: "dist", index: "main.html" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("default");
    expect(configs[0]!.config).toEqual({
      dir: "dist",
      index: "main.html",
    });
  });

  it("should have empty deps, params, static globs, and route patterns", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite({ dir: "dist" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs[0]!.depsKeys).toEqual([]);
    expect(configs[0]!.secretEntries).toEqual([]);
    expect(configs[0]!.staticGlobs).toEqual([]);
    expect(configs[0]!.routePatterns).toEqual([]);
    expect(configs[0]!.apiRoutes).toEqual([]);
  });

  it("should detect middleware and set hasHandler to true", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const admin = defineStaticSite({ dir: "admin/dist" })
        .middleware(async (request) => {
          if (!request.cookies.session) {
            return { redirect: "/login" };
          }
        })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.exportName).toBe("admin");
    expect(configs[0]!.hasHandler).toBe(true);
    expect(configs[0]!.config).not.toHaveProperty("middleware");
    expect(configs[0]!.config).toEqual({ dir: "admin/dist" });
  });

  it("should set hasHandler to false when no middleware", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite({ dir: "dist", errorPage: "index.html" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.hasHandler).toBe(false);
  });

  it("should extract record-form domain for per-stage configuration", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const app = defineStaticSite({
        dir: "dist",
        domain: { prod: "example.com", dev: "dev.example.com" },
      })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.config.domain).toEqual({
      prod: "example.com",
      dev: "dev.example.com",
    });
  });

  it("should extract string domain", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const app = defineStaticSite({ dir: "dist", domain: "example.com" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.config.domain).toBe("example.com");
  });

  it("should extract single API route pattern", async () => {
    const source = `
      import { defineStaticSite, defineApi } from "effortless-aws";
      const api = {} as any;

      export const app = defineStaticSite({ dir: "dist" })
        .route("/api/*", api)
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.routePatterns).toEqual(["/api/*"]);
    expect(configs[0]!.config).not.toHaveProperty("routes");
  });

  it("should extract multiple API route patterns", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      const api = {} as any;
      const auth = {} as any;

      export const app = defineStaticSite({ dir: "dist" })
        .route("/api/*", api)
        .route("/auth/*", auth)
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs[0]!.routePatterns).toEqual(["/api/*", "/auth/*"]);
  });

  it("should extract apiRoutes with handler export names", async () => {
    const source = `
      import { defineApi, defineStaticSite } from "effortless-aws";

      export const siteApi = defineApi({ basePath: "/api" });

      export const app = defineStaticSite({ dir: "dist" })
        .route("/api/*", siteApi)
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.apiRoutes).toEqual([
      { pattern: "/api/*", handlerExport: "siteApi" },
    ]);
    expect(configs[0]!.routePatterns).toEqual(["/api/*"]);
  });

  it("should extract multiple apiRoutes with different handlers", async () => {
    const source = `
      import { defineApi, defineStaticSite } from "effortless-aws";

      export const api = defineApi({ basePath: "/api" });
      export const auth = defineApi({ basePath: "/auth" });

      export const app = defineStaticSite({ dir: "dist" })
        .route("/api/*", api)
        .route("/auth/*", auth)
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs[0]!.apiRoutes).toEqual([
      { pattern: "/api/*", handlerExport: "api" },
      { pattern: "/auth/*", handlerExport: "auth" },
    ]);
  });

  it("should extract route patterns from default export", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";
      const api = {} as any;

      export default defineStaticSite({ dir: "dist" })
        .route("/api/*", api)
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.routePatterns).toEqual(["/api/*"]);
  });

  it("should preserve errorPage in extracted config", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite({ dir: "dist", errorPage: "404.html" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.config.errorPage).toBe("404.html");
  });

  it("should not have errorPage in config when not specified", async () => {
    const source = `
      import { defineStaticSite } from "effortless-aws";

      export const docs = defineStaticSite({ dir: "dist" })
        .build();
    `;

    const configs = await extractStaticSiteConfigs(source);

    expect(configs[0]!.config.errorPage).toBeUndefined();
  });

  it("should not match defineApp or other define* calls", async () => {
    const source = `
      import { defineApp } from "effortless-aws";

      export const app = defineApp()({
        path: "/app",
        dir: "src/webapp",
      });
    `;

    const configs = await extractStaticSiteConfigs(source);
    expect(configs).toHaveLength(0);
  });

  it("should resolve apiRoutes when handler is imported from another file", async () => {
    const projectDir = path.resolve(import.meta.dirname, "../..");
    const fixtureDir = path.join(import.meta.dirname, "fixtures/cross-file-route");
    const files = [
      path.join(fixtureDir, "api.ts"),
      path.join(fixtureDir, "site.ts"),
    ];

    const discovered = await Effect.runPromise(
      discoverHandlers(files).pipe(Effect.provide(NodeContext.layer))
    );

    expect(discovered.staticSiteHandlers).toHaveLength(1);
    const site = discovered.staticSiteHandlers[0]!.exports[0]!;
    expect(site.apiRoutes).toEqual([
      { pattern: "/site-api/*", handlerExport: "siteApi2" },
    ]);
  });

  it("should extract access: 'private' on a bucket route", () => {
    const source = `
      import { defineStaticSite, defineBucket } from "effortless-aws";

      export const storage = defineBucket({ prefix: "uploads/" })
        .onUpload(async () => {});

      export const app = defineStaticSite({ dir: "dist" })
        .route("/files/*", storage, { access: "private" })
        .build();
    `;

    const configs = extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    // Before resolution, routes are stored in apiRoutes with access preserved
    expect(configs[0]!.apiRoutes).toEqual([
      { pattern: "/files/*", handlerExport: "storage", access: "private" },
    ]);

    // After resolution, bucket routes should carry the access value
    const allExports = new Map<string, { type: HandlerType; exportName: string }>([
      ["storage", { type: "bucket", exportName: "storage" }],
    ]);
    resolveStaticSiteRoutes(configs, allExports, source);

    expect(configs[0]!.bucketRoutes).toEqual([
      { pattern: "/files/*", bucketExportName: "storage", access: "private" },
    ]);
    expect(configs[0]!.apiRoutes).toEqual([]);
  });

  it("should extract access: 'public' on a bucket route", () => {
    const source = `
      import { defineStaticSite, defineBucket } from "effortless-aws";

      export const assets = defineBucket({ prefix: "assets/" })
        .onUpload(async () => {});

      export const app = defineStaticSite({ dir: "dist" })
        .route("/assets/*", assets, { access: "public" })
        .build();
    `;

    const configs = extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    expect(configs[0]!.apiRoutes).toEqual([
      { pattern: "/assets/*", handlerExport: "assets", access: "public" },
    ]);

    const allExports = new Map<string, { type: HandlerType; exportName: string }>([
      ["assets", { type: "bucket", exportName: "assets" }],
    ]);
    resolveStaticSiteRoutes(configs, allExports, source);

    expect(configs[0]!.bucketRoutes).toEqual([
      { pattern: "/assets/*", bucketExportName: "assets", access: "public" },
    ]);
    expect(configs[0]!.apiRoutes).toEqual([]);
  });

  it("should default bucket route access to 'public' when not specified", () => {
    const source = `
      import { defineStaticSite, defineBucket } from "effortless-aws";

      export const media = defineBucket({ prefix: "media/" })
        .onUpload(async () => {});

      export const app = defineStaticSite({ dir: "dist" })
        .route("/media/*", media)
        .build();
    `;

    const configs = extractStaticSiteConfigs(source);

    expect(configs).toHaveLength(1);
    // No access specified, so apiRoutes entry should have undefined access
    expect(configs[0]!.apiRoutes).toEqual([
      { pattern: "/media/*", handlerExport: "media" },
    ]);

    const allExports = new Map<string, { type: HandlerType; exportName: string }>([
      ["media", { type: "bucket", exportName: "media" }],
    ]);
    resolveStaticSiteRoutes(configs, allExports, source);

    // Should default to "public" when no access is specified
    expect(configs[0]!.bucketRoutes).toEqual([
      { pattern: "/media/*", bucketExportName: "media", access: "public" },
    ]);
    expect(configs[0]!.apiRoutes).toEqual([]);
  });

});
