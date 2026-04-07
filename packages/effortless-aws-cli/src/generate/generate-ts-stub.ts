/**
 * Generates handler.ts scaffold for an API handler.
 * Only generated once — never overwritten if file exists.
 */

export type GenerateStubInput = {
  deps: Record<string, string>;
};

export const generateApiStub = (input: GenerateStubInput): string => {
  const hasDeps = Object.keys(input.deps).length > 0;
  const depNames = Object.keys(input.deps);

  const ctxArgs = ["req", "ok", "fail", ...depNames].join(", ");

  return `// Implement your API handler here.
// Routing is up to you — use if/else, switch, or any router library.
import type { HandlerContext } from "./handler.gen";
import { createHandler } from "./handler.gen";

export const handler = createHandler(async ({ ${ctxArgs} }) => {
  // Example: simple routing
  if (req.method === "GET" && req.path === "/") {
    return ok({ message: "Hello from effortless-aws!" });
  }

  return fail("Not found", 404);
});
`;
};
