import { defineProject } from "effortless-aws";

export default defineProject(({ table, api, bucket, cron, secret }) => ({
  name: "test-project",
  region: "eu-central-1",

  // Resources
  orders: table(),
  uploads: bucket(),
  stripeKey: secret(),

  // Handlers
  ordersApi: api({
    basePath: "/orders",
    handler: "./handlers/orders-api.ts",
    link: ["orders", "uploads", "stripeKey"],
  }),

  cleanup: cron({
    schedule: "rate(1 day)",
    handler: "./handlers/cleanup.ts",
    link: ["orders"],
  }),
}));
