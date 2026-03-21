import { describe, it, expect } from "vitest"
import * as esbuild from "esbuild"
import { builtinModules } from "module"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"

const projectDir = path.resolve(import.meta.dirname, "..")

/**
 * Regression test: discovery bundle must inject a createRequire banner so that
 * CJS dependencies using require() for Node.js builtins work in ESM output.
 *
 * Without the banner, esbuild's __require shim throws "Dynamic require of X
 * is not supported" in pure ESM environments (e.g. Lambda, node --input-type=module).
 * vitest provides `require` globally which masks the error, so we verify the
 * banner is present in the output and the bundle imports correctly.
 */
describe("discovery bundle: CJS require() support", () => {

  it("bundle with createRequire banner should handle CJS deps using require()", async () => {
    const source = `
      import { inspect } from "./test/fixtures/cjs-dep.cjs";
      export const result = inspect({ a: 1 });
    `;

    const hash = crypto.createHash("md5").update(source).digest("hex").slice(0, 8);
    const tempSrc = path.join(projectDir, `.temp-cjs-src-${hash}.ts`);
    const tempBundle = path.join(projectDir, `.temp-cjs-bundle-${hash}.mjs`);
    fs.writeFileSync(tempSrc, source);

    try {
      // Replicate importHandlerModule's esbuild config (with the banner)
      const result = await esbuild.build({
        entryPoints: [tempSrc],
        bundle: true,
        platform: "node",
        target: "node22",
        write: false,
        format: "esm",
        external: ["@aws-sdk/*", "@smithy/*", ...builtinModules.flatMap(m => [m, `node:${m}`])],
        absWorkingDir: projectDir,
        banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      });

      const code = result.outputFiles![0]!.text;

      // CJS interop shim must be present (proves esbuild encountered a CJS require)
      expect(code).toContain("__require");

      // The createRequire banner must be at the top so __require resolves correctly
      expect(code).toContain("createRequire");

      // Bundle should import and execute without errors
      fs.writeFileSync(tempBundle, code);
      const mod = await import(tempBundle);
      expect(mod.result).toBeDefined();
    } finally {
      for (const f of [tempSrc, tempBundle]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

});
