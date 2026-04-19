import { defineConfig } from "tsup";

export default defineConfig([
  // Public library (handler definitions + types)
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  // Runtime wrappers - separate files consumed by CLI at deploy time
  {
    entry: {
      "runtime/wrap-table-stream": "src/runtime/wrap-table-stream.ts",
      "runtime/wrap-queue": "src/runtime/wrap-queue.ts",
      "runtime/wrap-bucket": "src/runtime/wrap-bucket.ts",
      "runtime/wrap-middleware": "src/runtime/wrap-middleware.ts",
      "runtime/wrap-api": "src/runtime/wrap-api.ts",
      "runtime/wrap-cron": "src/runtime/wrap-cron.ts",
      "runtime/wrap-worker": "src/runtime/wrap-worker.ts",
      "runtime/wrap-mcp": "src/runtime/wrap-mcp.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    platform: "node",
    target: "node22",
    external: [/^@aws-sdk\//],
  },
]);
