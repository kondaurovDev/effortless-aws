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
      const entries = zip.getEntries().map(e => e.entryName);

      // Check structure
      expect(entries).toContain("nodejs/node_modules/pkg-a/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-a/index.js");
      expect(entries).toContain("nodejs/node_modules/pkg-b/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-b/index.js");
    });

    it("should include transitive dependencies", async () => {
      // Use collectLayerPackages to trace dependencies (uses @vercel/nft)
      const packages = await collectLayerPackages(tempDir, ["pkg-b"]);

      // pkg-b depends on pkg-c, so pkg-c should be traced
      expect(packages).toContain("pkg-b");
      expect(packages).toContain("pkg-c");

      const result = await Effect.runPromise(
        createLayerZip(tempDir, packages)
      );

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map(e => e.entryName);

      // Both should be in the zip
      expect(entries).toContain("nodejs/node_modules/pkg-b/package.json");
      expect(entries).toContain("nodejs/node_modules/pkg-c/package.json");
    });

    it("should not include packages not in dependency list", async () => {
      const result = await Effect.runPromise(
        createLayerZip(tempDir, ["pkg-a"])
      );

      const zip = new AdmZip(result.buffer);
      const entries = zip.getEntries().map(e => e.entryName);

      expect(entries).toContain("nodejs/node_modules/pkg-a/package.json");
      expect(entries.some(e => e.includes("pkg-b"))).toBe(false);
      expect(entries.some(e => e.includes("dev-pkg"))).toBe(false);
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
      const entries = zip.getEntries().map(e => e.entryName);

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
  });
});
