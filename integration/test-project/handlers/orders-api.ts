// Implement your API handler here.
// Routing is up to you — use if/else, switch, or any router library.
import { createHandler } from "./orders-api.gen";

export const handler = createHandler(async ({ req, ok, fail, orders, uploads }) => {
  // Example: simple routing
  if (req.method === "GET" && req.path === "/") {
    return ok({ message: "Hello from effortless-aws!" });
  }

  return fail("Not found", 404);
});
