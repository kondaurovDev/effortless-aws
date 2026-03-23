/**
 * Resource cleanup — re-exports from resource-registry.
 *
 * Cleanup is name-based: given a handler type and name, the registry
 * derives all resource names from the naming convention and deletes directly.
 * No dependency on the Resource Groups Tagging API for deletion.
 */

export { deleteHandlerResources, HANDLER_RESOURCES } from "./resource-registry";
export type { HandlerType, ResourceSpec } from "./resource-registry";
