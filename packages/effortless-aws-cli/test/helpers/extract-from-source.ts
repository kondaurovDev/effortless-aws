import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { extractConfigsFromFile } from "~cli/build/bundle";
import type { HandlerType, ExtractedConfig } from "~cli/build/handler-registry";

const projectDir = path.resolve(import.meta.dirname, "../..");

/**
 * Test helper: writes source to a temp .ts file, extracts configs via runtime import, cleans up.
 */
const extractFromSource = async (source: string, type: HandlerType): Promise<ExtractedConfig<any>[]> => {
  const hash = crypto.createHash("md5").update(source).digest("hex").slice(0, 8);
  const tempFile = path.join(projectDir, `.temp-extract-${hash}.ts`);
  fs.writeFileSync(tempFile, source);
  try {
    return await Effect.runPromise(
      extractConfigsFromFile(tempFile, projectDir, type).pipe(
        Effect.provide(NodeContext.layer),
      )
    );
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
};

export const extractTableConfigs = (source: string) => extractFromSource(source, "table");
export const extractApiConfigs = (source: string) => extractFromSource(source, "api");
export const extractAppConfigs = (source: string) => extractFromSource(source, "app");
export const extractFifoQueueConfigs = (source: string) => extractFromSource(source, "fifoQueue");
export const extractStaticSiteConfigs = (source: string) => extractFromSource(source, "staticSite");
