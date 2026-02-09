import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { bundle, type BundleInput } from "~/build/bundle";
import type { HandlerType } from "~/build/handler-registry";

// AWS SDK packages are externalized in production (via Lambda layer).
// Externalize them in tests so file-based imports resolve from node_modules.
const AWS_EXTERNAL = [
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/util-dynamodb",
];

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
      const external = [...AWS_EXTERNAL, ...(input.external ?? [])];
      const result = yield* bundle({
        file: tempFile,
        projectDir: input.projectDir,
        ...(input.format && { format: input.format }),
        ...(input.exportName && { exportName: input.exportName }),
        external,
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

/**
 * Bundle code and import it via a temp .mjs file.
 * Unlike data URLs, file-based imports can resolve bare specifiers (e.g. @aws-sdk/*).
 */
export const importBundle = async (input: BundleCodeInput) => {
  const code = await Effect.runPromise(bundleCode(input));
  const hash = crypto.createHash("md5").update(code).digest("hex").slice(0, 8);
  const tempMjs = path.join(input.projectDir, `.temp-bundle-${hash}.mjs`);
  fs.writeFileSync(tempMjs, code);
  try {
    return await import(tempMjs);
  } finally {
    if (fs.existsSync(tempMjs)) {
      fs.unlinkSync(tempMjs);
    }
  }
};
