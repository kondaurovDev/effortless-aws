import { defineConfig } from "tsup";

export default defineConfig([
  // Public library (handlers only)
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["effect"],
  },
  // CLI - bundle effect so users don't need it
  {
    entry: {
      "cli/index": "src/cli/index.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    platform: "node",
    target: "node20",
    noExternal: [
      "effect",
      /^@effect\//,
    ],
    external: [
      /^@aws-sdk\//,
      "archiver",
      "esbuild",
      "ts-morph",
      "glob",
      "@vercel/nft",
    ],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  },
  // Runtime wrappers - separate files for esbuild to consume at deploy time
  {
    entry: {
      "runtime/wrap-http": "src/runtime/wrap-http.ts",
      "runtime/wrap-table-stream": "src/runtime/wrap-table-stream.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    platform: "node",
    target: "node22",
    external: [/^@aws-sdk\//],
  },
]);
