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
      "runtime/wrap-fifo-queue": "src/runtime/wrap-fifo-queue.ts",
      "runtime/wrap-bucket": "src/runtime/wrap-bucket.ts",
      "runtime/wrap-middleware": "src/runtime/wrap-middleware.ts",
      "runtime/wrap-api": "src/runtime/wrap-api.ts",
      "runtime/wrap-cron": "src/runtime/wrap-cron.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    platform: "node",
    target: "node22",
    external: [/^@aws-sdk\//],
  },
]);
