import { describe, it, expect } from "vitest"
import { generateEntryPoint } from "~cli/build/handler-registry"
import type { HandlerType } from "~cli/core/handler-types"

describe("generateEntryPoint", () => {
  it("generates entry point with __preload call", () => {
    const result = generateEntryPoint("./handler.ts", "myApi", "api");
    expect(result).toContain("await handler.__preload?.();");
  });

  it("generates correct import for named export", () => {
    const result = generateEntryPoint("./handler.ts", "myApi", "api");
    expect(result).toContain('import { myApi } from "./handler.ts";');
    expect(result).toContain("export const handler = wrapApi(myApi);");
  });

  it("generates correct import for default export", () => {
    const result = generateEntryPoint("./handler.ts", "default", "api");
    expect(result).toContain('import __handler from "./handler.ts";');
    expect(result).toContain("export const handler = wrapApi(__handler);");
  });

  it("uses correct wrapper function for each handler type", () => {
    const cases: [HandlerType, string][] = [
      ["api", "wrapApi"],
      ["cron", "wrapCron"],
      ["bucket", "wrapBucket"],
      ["queue", "wrapQueue"],
      ["table", "wrapTableStream"],
      ["mcp", "wrapMcp"],
    ];

    for (const [type, wrapperFn] of cases) {
      const result = generateEntryPoint("./handler.ts", "handler", type);
      expect(result).toContain(`export const handler = ${wrapperFn}(handler);`);
    }
  });

  it("uses custom runtimeDir when provided", () => {
    const result = generateEntryPoint("./handler.ts", "myApi", "api", "/custom/runtime");
    expect(result).toContain('from "/custom/runtime/wrap-api"');
  });

  it("always includes __preload call after handler export", () => {
    const types: HandlerType[] = ["api", "cron", "bucket", "queue", "table", "mcp"];

    for (const type of types) {
      const result = generateEntryPoint("./handler.ts", "handler", type);
      // __preload should appear after the handler export
      const handlerLine = result.indexOf("export const handler = ");
      const preloadLine = result.indexOf("await handler.__preload?.();");
      expect(preloadLine).toBeGreaterThan(handlerLine);
    }
  });
});
