import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "effortless-docs",
  region: "eu-central-1",
  handlers: ["src/handlers.ts"],
});
