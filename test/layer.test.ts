import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import AdmZip from "adm-zip";

import {
  createLayerZip,
  computeLockfileHash,
  readProductionDependencies,
  collectLayerPackages
} from "~/aws/layer";

describe("layer", () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create temp project directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "layer-test-"));

    // Create package.json
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        dependencies: {
          "pkg-a": "1.0.0",
          "pkg-b": "2.0.0"
        },
        devDependencies: {
          "dev-pkg": "1.0.0"
        }
      })
    );

    // Create package-lock.json
    await fs.writeFile(
      path.join(tempDir, "package-lock.json"),
      JSON.stringify({
        name: "test-project",
        lockfileVersion: 3,
        packages: {
          "node_modules/pkg-a": { version: "1.0.0" },
          "node_modules/pkg-b": { version: "2.0.0" },
          "node_modules/pkg-c": { version: "3.0.0" }
        }
      })
    );

    // Create node_modules structure
    const nodeModules = path.join(tempDir, "node_modules");
    await fs.mkdir(nodeModules, { recursive: true });

    // pkg-a with no dependencies
    await fs.mkdir(path.join(nodeModules, "pkg-a"));
    await fs.writeFile(
      path.join(nodeModules, "pkg-a", "package.json"),
      JSON.stringify({ name: "pkg-a", version: "1.0.0" })
    );
    await fs.writeFile(
      path.join(nodeModules, "pkg-a", "index.js"),
      'module.exports = "pkg-a";'
    );

    // pkg-b depends on pkg-c (transitive dependency)
    await fs.mkdir(path.join(nodeModules, "pkg-b"));
    await fs.writeFile(
      path.join(nodeModules, "pkg-b", "package.json"),
      JSON.stringify({
        name: "pkg-b",
        version: "2.0.0",
        dependencies: { "pkg-c": "3.0.0" }
      })
    );
    await fs.writeFile(
      path.join(nodeModules, "pkg-b", "index.js"),
      'module.exports = require("pkg-c");'
    );

    // pkg-c (transitive dependency of pkg-b)
    await fs.mkdir(path.join(nodeModules, "pkg-c"));
    await fs.writeFile(
      path.join(nodeModules, "pkg-c", "package.json"),
      JSON.stringify({ name: "pkg-c", version: "3.0.0" })
    );
    await fs.writeFile(
      path.join(nodeModules, "pkg-c", "index.js"),
      'module.exports = "pkg-c";'
    );

    // Scoped package @scope/pkg-d
    await fs.mkdir(path.join(nodeModules, "@scope"), { recursive: true });
    await fs.mkdir(path.join(nodeModules, "@scope", "pkg-d"));
    await fs.writeFile(
      path.join(nodeModules, "@scope", "pkg-d", "package.json"),
      JSON.stringify({ name: "@scope/pkg-d", version: "1.0.0" })
    );
    await fs.writeFile(
      path.join(nodeModules, "@scope", "pkg-d", "index.js"),
      'module.exports = "scoped";'
    );

    // dev-pkg (should NOT be included)
    await fs.mkdir(path.join(nodeModules, "dev-pkg"));
    await fs.writeFile(
      path.join(nodeModules, "dev-pkg", "package.json"),
      JSON.stringify({ name: "dev-pkg", version: "1.0.0" })
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readProductionDependencies", () => {
    it("should read only production dependencies", async () => {
      const deps = await Effect.runPromise(readProductionDependencies(tempDir));

      expect(deps).toContain("pkg-a");
      expect(deps).toContain("pkg-b");
      expect(deps).not.toContain("dev-pkg");
      expect(deps).toHaveLength(2);
    });
  });

  describe("computeLockfileHash", () => {
    it("should compute consistent hash", async () => {
      const hash1 = await Effect.runPromise(computeLockfileHash(tempDir));
      const hash2 = await Effect.runPromise(computeLockfileHash(tempDir));

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(8);
      expect(hash1).toMatch(/^[a-f0-9]+$/);
    });

    it("should change when dependency version changes", async () => {
      const hash1 = await Effect.runPromise(computeLockfileHash(tempDir));

      // Change version of existing package in node_modules
      const pkgJsonPath = path.join(tempDir, "node_modules", "pkg-a", "package.json");
      const original = await fs.readFile(pkgJsonPath, "utf-8");
      const modified = JSON.parse(original);
      modified.version = "2.0.0";
      await fs.writeFile(pkgJsonPath, JSON.stringify(modified));

      const hash2 = await Effect.runPromise(computeLockfileHash(tempDir));

      expect(hash1).not.toBe(hash2);

      // Restore original
      await fs.writeFile(pkgJsonPath, original);
    });
  });

  describe("createLayerZip", () => {
    it("should create valid zip with nodejs/node_modules structure", async () => {
      const result = await Effect.runPromise(
        createLayerZip(tempDir, ["pkg-a", "pkg-b"])
      );

      // ZIP file starts with PK signature
      expect(result.buffer[0]).toBe(0x50); // P
      expect(result.buffer[1]).toBe(0x4b); // K

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map((e) => e.entryName);

      // Check structure
      expect(entries).toContain("nodejs/node_modules/pkg-a/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-a/index.js");
      expect(entries).toContain("nodejs/node_modules/pkg-b/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-b/index.js");
    });

    it("should include transitive dependencies", async () => {
      const { packages, warnings } = collectLayerPackages(tempDir, ["pkg-b"]);

      // pkg-b depends on pkg-c, so pkg-c should be traced
      expect(packages).toContain("pkg-b");
      expect(packages).toContain("pkg-c");

      const result = await Effect.runPromise(
        createLayerZip(tempDir, packages)
      );

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);

      // Both should be in the zip
      expect(entries).toContain("nodejs/node_modules/pkg-b/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-c/package.json");
    });

    it("should not include packages not in dependency list", async () => {
      const result = await Effect.runPromise(
        createLayerZip(tempDir, ["pkg-a"])
      );

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);

      expect(entries).toContain("nodejs/node_modules/pkg-a/package.json");
      expect(entries.some((e: string) => e.includes("pkg-b"))).toBe(false);
      expect(entries.some((e: string) => e.includes("dev-pkg"))).toBe(false);
    });

    it("should handle scoped packages", async () => {
      // Add scoped package to package.json deps
      const pkgPath = path.join(tempDir, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      pkg.dependencies["@scope/pkg-d"] = "1.0.0";
      await fs.writeFile(pkgPath, JSON.stringify(pkg));

      const result = await Effect.runPromise(
        createLayerZip(tempDir, ["@scope/pkg-d"])
      );

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);

      expect(entries).toContain("nodejs/node_modules/@scope/pkg-d/package.json");
      expect(entries).toContain("nodejs/node_modules/@scope/pkg-d/index.js");

      // Restore
      delete pkg.dependencies["@scope/pkg-d"];
      await fs.writeFile(pkgPath, JSON.stringify(pkg));
    });

    it("should create deterministic zip (same content = same result)", async () => {
      const result1 = await Effect.runPromise(createLayerZip(tempDir, ["pkg-a"]));
      const result2 = await Effect.runPromise(createLayerZip(tempDir, ["pkg-a"]));

      expect(result1.buffer.equals(result2.buffer)).toBe(true);
    });

    it("should return empty-ish zip for empty dependency list", async () => {
      const result = await Effect.runPromise(createLayerZip(tempDir, []));

      // Still a valid zip
      expect(result.buffer[0]).toBe(0x50);
      expect(result.buffer[1]).toBe(0x4b);

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries();

      expect(entries.length).toBe(0);
    });

    it("should include packages via resolvedPaths even when not in root node_modules", async () => {
      // Create a package in a non-standard location (simulating pnpm nested structure)
      const nestedDir = path.join(tempDir, ".nested-pkg");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(
        path.join(nestedDir, "package.json"),
        JSON.stringify({ name: "pkg-hidden", version: "1.0.0" })
      );
      await fs.writeFile(
        path.join(nestedDir, "index.js"),
        'module.exports = "hidden";'
      );

      // Without resolvedPaths, this package would be skipped
      const resultWithout = await Effect.runPromise(
        createLayerZip(tempDir, ["pkg-hidden"])
      );
      expect(resultWithout.skippedPackages).toContain("pkg-hidden");
      expect(resultWithout.includedPackages).not.toContain("pkg-hidden");

      // With resolvedPaths, it should be included
      const resolvedPaths = new Map([["pkg-hidden", nestedDir]]);
      const resultWith = await Effect.runPromise(
        createLayerZip(tempDir, ["pkg-hidden"], resolvedPaths)
      );
      expect(resultWith.includedPackages).toContain("pkg-hidden");
      expect(resultWith.skippedPackages).not.toContain("pkg-hidden");

      const zip = new AdmZip(resultWith.buffer);
      const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);
      expect(entries).toContain("nodejs/node_modules/pkg-hidden/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-hidden/index.js");

      await fs.rm(nestedDir, { recursive: true });
    });
  });

  describe("collectLayerPackages", () => {
    it("should return resolvedPaths for all collected packages", () => {
      const result = collectLayerPackages(tempDir, ["pkg-a", "pkg-b"]);

      // All packages should have resolved paths
      for (const pkg of result.packages) {
        expect(result.resolvedPaths.has(pkg)).toBe(true);
        const resolvedPath = result.resolvedPaths.get(pkg)!;
        expect(path.isAbsolute(resolvedPath)).toBe(true);
      }

      // Transitive dep pkg-c should also have a resolved path
      expect(result.packages).toContain("pkg-c");
      expect(result.resolvedPaths.has("pkg-c")).toBe(true);
    });

    it("should resolve pnpm nested deps via parent's node_modules", async () => {
      // Simulate pnpm structure: pkg-parent depends on pkg-child,
      // pkg-child is only accessible via pkg-parent's sibling node_modules
      const pnpmDir = path.join(tempDir, "node_modules", ".pnpm");
      const parentStore = path.join(pnpmDir, "pkg-parent@1.0.0", "node_modules");

      await fs.mkdir(path.join(parentStore, "pkg-parent"), { recursive: true });
      await fs.writeFile(
        path.join(parentStore, "pkg-parent", "package.json"),
        JSON.stringify({
          name: "pkg-parent",
          version: "1.0.0",
          dependencies: { "pkg-child": "1.0.0" }
        })
      );
      await fs.writeFile(
        path.join(parentStore, "pkg-parent", "index.js"),
        'module.exports = require("pkg-child");'
      );

      // pkg-child lives as a sibling in the pnpm store (only accessible via parent's node_modules)
      await fs.mkdir(path.join(parentStore, "pkg-child"), { recursive: true });
      await fs.writeFile(
        path.join(parentStore, "pkg-child", "package.json"),
        JSON.stringify({ name: "pkg-child", version: "1.0.0" })
      );
      await fs.writeFile(
        path.join(parentStore, "pkg-child", "index.js"),
        'module.exports = "child";'
      );

      // Create symlink at root level (like pnpm does)
      const rootSymlink = path.join(tempDir, "node_modules", "pkg-parent");
      await fs.symlink(path.join(parentStore, "pkg-parent"), rootSymlink);

      const result = collectLayerPackages(tempDir, ["pkg-parent"]);

      // Both should be discovered with resolved paths
      expect(result.packages).toContain("pkg-parent");
      expect(result.packages).toContain("pkg-child");
      expect(result.resolvedPaths.has("pkg-parent")).toBe(true);
      expect(result.resolvedPaths.has("pkg-child")).toBe(true);

      // The ZIP should include both packages
      const zipResult = await Effect.runPromise(
        createLayerZip(tempDir, result.packages, result.resolvedPaths)
      );
      expect(zipResult.includedPackages).toContain("pkg-parent");
      expect(zipResult.includedPackages).toContain("pkg-child");
      expect(zipResult.skippedPackages).not.toContain("pkg-child");

      const zip = new AdmZip(zipResult.buffer);
      const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);
      expect(entries).toContain("nodejs/node_modules/pkg-child/package.json");

      // Cleanup
      await fs.rm(rootSymlink);
      await fs.rm(pnpmDir, { recursive: true });
    });

    it("should collect deps from multiple package versions in Phase 2", async () => {
      // Simulate: pkg-multi v3 at root (no deps), pkg-multi v2 in pnpm store (depends on pkg-v2-dep)
      const nodeModules = path.join(tempDir, "node_modules");
      const pnpmDir = path.join(nodeModules, ".pnpm");

      // pkg-multi v3 at root — no dependencies
      await fs.mkdir(path.join(nodeModules, "pkg-multi"), { recursive: true });
      await fs.writeFile(
        path.join(nodeModules, "pkg-multi", "package.json"),
        JSON.stringify({ name: "pkg-multi", version: "3.0.0" })
      );
      await fs.writeFile(
        path.join(nodeModules, "pkg-multi", "index.js"),
        'module.exports = "v3";'
      );

      // pkg-multi v2 in pnpm store — depends on pkg-v2-dep
      const v2Store = path.join(pnpmDir, "pkg-multi@2.0.0", "node_modules");
      await fs.mkdir(path.join(v2Store, "pkg-multi"), { recursive: true });
      await fs.writeFile(
        path.join(v2Store, "pkg-multi", "package.json"),
        JSON.stringify({
          name: "pkg-multi",
          version: "2.0.0",
          dependencies: { "pkg-v2-dep": "1.0.0" }
        })
      );

      // pkg-v2-dep in pnpm store (sibling of v2's pkg-multi)
      await fs.mkdir(path.join(v2Store, "pkg-v2-dep"), { recursive: true });
      await fs.writeFile(
        path.join(v2Store, "pkg-v2-dep", "package.json"),
        JSON.stringify({ name: "pkg-v2-dep", version: "1.0.0" })
      );
      await fs.writeFile(
        path.join(v2Store, "pkg-v2-dep", "index.js"),
        'module.exports = "v2-dep";'
      );

      // pkg-consumer depends on pkg-multi (Phase 1 will find v3 at root)
      await fs.mkdir(path.join(nodeModules, "pkg-consumer"), { recursive: true });
      await fs.writeFile(
        path.join(nodeModules, "pkg-consumer", "package.json"),
        JSON.stringify({
          name: "pkg-consumer",
          version: "1.0.0",
          dependencies: { "pkg-multi": "3.0.0" }
        })
      );

      const result = collectLayerPackages(tempDir, ["pkg-consumer"]);

      // Phase 1 finds pkg-multi v3 (at root), which has no deps
      // Phase 2 also checks findPackagePath result (also v3 at root)
      // and the resolvedPaths path. Both point to v3, so pkg-v2-dep won't be auto-added
      // because v3 has no deps. This verifies the dual-path check doesn't crash.
      expect(result.packages).toContain("pkg-consumer");
      expect(result.packages).toContain("pkg-multi");

      // Now test with findPackagePath returning v2 (by making root point to v2 via symlink)
      await fs.rm(path.join(nodeModules, "pkg-multi"), { recursive: true });
      await fs.symlink(
        path.join(v2Store, "pkg-multi"),
        path.join(nodeModules, "pkg-multi")
      );

      const result2 = collectLayerPackages(tempDir, ["pkg-consumer"]);

      // Now Phase 2 should find pkg-v2-dep via v2's deps
      expect(result2.packages).toContain("pkg-v2-dep");
      expect(result2.resolvedPaths.has("pkg-v2-dep")).toBe(true);

      // ZIP should include pkg-v2-dep
      const zipResult = await Effect.runPromise(
        createLayerZip(tempDir, result2.packages, result2.resolvedPaths)
      );
      expect(zipResult.includedPackages).toContain("pkg-v2-dep");

      // Cleanup
      await fs.rm(path.join(nodeModules, "pkg-multi"));
      await fs.rm(path.join(nodeModules, "pkg-consumer"), { recursive: true });
      await fs.rm(pnpmDir, { recursive: true });
    });
  });
});
