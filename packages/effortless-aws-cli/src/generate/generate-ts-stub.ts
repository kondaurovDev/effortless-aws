/**
 * Generates handler file scaffolds for all handler types.
 * Only generated once — never overwritten if file exists.
 */

export type GenerateStubInput = {
  type: string;
  deps: Record<string, string>;
  /** Name of the .gen file without extension (e.g. "api.gen" for api.gen.ts). Default: "handler.gen" */
  genName?: string;
};

export const generateStub = (input: GenerateStubInput): string => {
  const depNames = Object.keys(input.deps);
  const genImport = `./${input.genName ?? "handler.gen"}`;

  switch (input.type) {
    case "api":
      return apiStub(depNames, genImport);
    case "cron":
      return cronStub(depNames, genImport);
    case "table":
      return tableStreamStub(depNames, genImport);
    case "bucket":
      return bucketStub(depNames, genImport);
    case "queue":
      return queueStub(depNames, genImport);
    default:
      return apiStub(depNames, genImport);
  }
};

/** @deprecated Use generateStub({ type: "api", deps }) instead */
export const generateApiStub = (input: { deps: Record<string, string> }): string => {
  return apiStub(Object.keys(input.deps), "./handler.gen");
};

const apiStub = (depNames: string[], genImport: string): string => {
  const ctxArgs = ["req", "ok", "fail", ...depNames].join(", ");

  return `// Implement your API handler here.
// Routing is up to you — use if/else, switch, or any router library.
import { createHandler } from "${genImport}";

export const handler = createHandler(async ({ ${ctxArgs} }) => {
  // Example: simple routing
  if (req.method === "GET" && req.path === "/") {
    return ok({ message: "Hello from effortless-aws!" });
  }

  return fail("Not found", 404);
});
`;
};

const cronStub = (depNames: string[], genImport: string): string => {
  const ctxArgs = depNames.length > 0 ? `{ ${depNames.join(", ")} }` : "";

  return `// Implement your cron handler here.
import { createHandler } from "${genImport}";

export const handler = createHandler(async (${ctxArgs}) => {
  // This runs on schedule
  console.log("Cron tick");
});
`;
};

const tableStreamStub = (depNames: string[], genImport: string): string => {
  const ctxArgs = ["record", ...depNames].join(", ");

  return `// Implement your table stream handler here.
import { createHandler } from "${genImport}";

export const handler = createHandler(async ({ ${ctxArgs} }) => {
  console.log("Record:", record.eventName, record.keys);
});
`;
};

const bucketStub = (depNames: string[], genImport: string): string => {
  const ctxArgs = ["event", ...depNames].join(", ");

  return `// Implement your bucket event handler here.
import { createHandler } from "${genImport}";

export const handler = createHandler(async ({ ${ctxArgs} }) => {
  console.log("Bucket event:", event.eventName, event.key);
});
`;
};

const queueStub = (depNames: string[], genImport: string): string => {
  const ctxArgs = ["message", ...depNames].join(", ");

  return `// Implement your queue message handler here.
import { createHandler } from "${genImport}";

export const handler = createHandler(async ({ ${ctxArgs} }) => {
  console.log("Message:", message.body);
});
`;
};
