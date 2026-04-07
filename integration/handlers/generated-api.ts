import { defineApi } from "effortless-aws";
import { db } from "./table";

export const generatedApi = defineApi({
  basePath: "/generated",
  handler: "./src/generated-api",
}).deps(() => ({ db })).build();
