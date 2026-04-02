import { defineConfig } from "effortless-aws";

export default defineConfig({
  name: "integration-test",
  region: "eu-central-1",
  handlers: ["handlers/**/*.ts"],
});
