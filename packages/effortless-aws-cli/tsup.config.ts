import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "cli/index": "src/cli/index.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    platform: "node",
    target: "node22",
  },
]);
