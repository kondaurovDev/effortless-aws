import { extractConfigs } from "~cli/discovery";
import type { HandlerType } from "~cli/core/handler-types";
import type { ExtractedConfig } from "~cli/core/extracted-config";

/**
 * Test helper: extracts handler configs from source code via AST parsing.
 * No temp files, no esbuild, no runtime import — pure static analysis.
 */
const extractFromSource = (source: string, type: HandlerType): ExtractedConfig<any>[] => {
  return extractConfigs(source, type);
};

export const extractTableConfigs = (source: string) => extractFromSource(source, "table");
export const extractApiConfigs = (source: string) => extractFromSource(source, "api");
export const extractAppConfigs = (source: string) => extractFromSource(source, "app");
export const extractFifoQueueConfigs = (source: string) => extractFromSource(source, "fifoQueue");
export const extractStaticSiteConfigs = (source: string) => extractFromSource(source, "staticSite");
