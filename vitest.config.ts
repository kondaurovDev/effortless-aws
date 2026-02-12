import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    exclude: ["test/__old/**", "node_modules/**", "docs/**"],
  },
})
