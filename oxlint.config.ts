import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  rules: {
    "eslint/no-unused-vars": "error",
  },
});
