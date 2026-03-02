export { handlerRegistry, generateEntryPoint, extractHandlerConfigs } from "./handler-registry";
export type { HandlerType, HandlerDefinition, ExtractedConfig } from "./handler-registry";

export {
  bundle,
  zip,
  extractConfig,
  extractConfigs,
  extractTableConfigs,
  findHandlerFiles,
  discoverHandlers
} from "./bundle";
export type {
  BundleInput,
  ZipInput,
  ExtractedFunction,
  ExtractedTableFunction,
  DiscoveredHandlers
} from "./bundle";
