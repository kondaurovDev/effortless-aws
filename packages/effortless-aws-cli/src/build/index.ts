export { handlerRegistry, generateEntryPoint } from "./handler-registry";
export type { HandlerType, HandlerDefinition, ExtractedConfig } from "./handler-registry";

export {
  bundle,
  zip,
  extractConfigsFromFile,
  findHandlerFiles,
  discoverHandlers
} from "./bundle";
export type {
  BundleInput,
  ZipInput,
  ExtractedApiFunction,
  ExtractedTableFunction,
  DiscoveredHandlers
} from "./bundle";
