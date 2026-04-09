export { handlers } from "../core";
export type { HandlerType, HandlerDefinition, ExtractedConfig } from "../core";
export { generateEntryPoint } from "./handler-registry";

export { bundle, zip, findHandlerFiles } from "./bundle";
export { Esbuild, esbuildBuild, esbuildEval, EsbuildError } from "./esbuild";
export type { BundleInput, ZipInput } from "./bundle";

// Layer (dependency collection & packaging)
export { findDepsDir, readProductionDependencies, computeLockfileHash, collectLayerPackages, checkDependencyWarnings, createLayerZip } from "./layer";
export type { CollectLayerResult, CreateLayerZipResult } from "./layer";

export { discoverHandlers, flattenHandlers, extractConfigs } from "../discovery";
export type {
  DiscoveredHandlers,
  ExtractedApiFunction,
  ExtractedTableFunction,
} from "../discovery";
