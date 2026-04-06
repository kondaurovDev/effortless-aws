import { defineApi } from "effortless-aws";

// API handler exported from a separate file — used by static-site-cross-file.ts
export const siteApi2 = defineApi({ basePath: "/site-api" })
  .get({ path: "/ping", public: true }, async ({ ok }) => ok({ pong: true }));
