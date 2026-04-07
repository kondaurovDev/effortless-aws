// Implement your API handler here.
// Routing is up to you — use if/else, switch, or any router library.
import type { HandlerContext } from "./handler.gen";
import { createHandler } from "./handler.gen";

export const handler = createHandler(async ({ req, ok, fail, db }) => {
  // Example: simple routing
  if (req.method === "GET" && req.path === "/") {
    return ok({ message: "Hello from effortless-aws!" });
  }

  return fail("Not found", 404);
});
