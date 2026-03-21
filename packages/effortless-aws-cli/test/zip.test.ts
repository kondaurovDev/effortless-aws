import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as path from "path"

import { zip } from "~cli/build/bundle"
import { bundleCode } from "./helpers/bundle-code"

const projectDir = path.resolve(__dirname, "..")

describe("zip", () => {

  it("should create valid zip archive", async () => {
    const handlerCode = `
      import { defineApi } from "effortless-aws";

      export default defineApi({ basePath: "/zip-test" })
        .routes([
          { path: "GET /", onRequest: async () => ({ status: 200, body: { ok: true } }) },
        ]);
    `;

    const result = await Effect.runPromise(bundleCode({ code: handlerCode, projectDir }));
    const zipBuffer = await Effect.runPromise(zip({ content: result.code }));

    // ZIP file starts with PK signature (0x504B)
    expect(zipBuffer[0]).toBe(0x50); // P
    expect(zipBuffer[1]).toBe(0x4B); // K

    expect(zipBuffer.length).toBeGreaterThan(0);
  });

});
