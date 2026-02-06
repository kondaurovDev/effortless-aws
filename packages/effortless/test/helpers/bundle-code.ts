import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { bundle, type BundleInput } from "~/build/bundle";
import type { HandlerType } from "~/build/handler-registry";

type BundleCodeInput = Omit<BundleInput, "file"> & {
  code: string;
  exportName?: string;
  external?: string[];
  type?: HandlerType;
};

/**
 * Test helper: writes code to temp file, bundles it, then cleans up
 */
export const bundleCode = (input: BundleCodeInput) =>
  Effect.gen(function* () {
    const hash = crypto.createHash("md5").update(input.code).digest("hex").slice(0, 8);
    const tempFile = path.join(input.projectDir, `.temp-${hash}.ts`);

    // Write temp file
    fs.writeFileSync(tempFile, input.code);

    try {
      // Bundle
      const result = yield* bundle({
        file: tempFile,
        projectDir: input.projectDir,
        ...(input.format && { format: input.format }),
        ...(input.exportName && { exportName: input.exportName }),
        ...(input.external && { external: input.external }),
        ...(input.type && { type: input.type }),
      });

      return result;
    } finally {
      // Cleanup
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });
