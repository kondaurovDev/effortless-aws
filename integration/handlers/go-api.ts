import { defineApi } from "effortless-aws";

export const goApi = defineApi({
  basePath: "/go",
  runtime: { lang: "go", handler: "go-handlers/api" },
});
