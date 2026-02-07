// Lambda
export { ensureLambda, deleteLambda } from "./lambda";
export type { LambdaConfig } from "./lambda";

// IAM
export { ensureRole, deleteRole, listEffortlessRoles } from "./iam";
export type { EffortlessRole } from "./iam";

// DynamoDB
export { ensureTable, deleteTable, ensureEventSourceMapping } from "./dynamodb";
export type { EnsureTableInput, EnsureTableResult, EnsureEventSourceMappingInput, KeyType, StreamView } from "./dynamodb";

// API Gateway
export { ensureProjectApi, addRouteToApi, deleteApi } from "./apigateway";
export type { ProjectApiConfig, RouteConfig, HttpMethod } from "./apigateway";

// Layer
export { ensureLayer, readProductionDependencies, computeLockfileHash, collectLayerPackages, listLayerVersions, deleteAllLayerVersions, deleteLayerVersion } from "./layer";
export type { LayerConfig, LayerResult, LayerVersionInfo } from "./layer";

// Tags
export { makeTags, toAwsTagList, resolveStage, getResourcesByTags, findOrphanedResources, groupResourcesByHandler } from "./tags";
export type { ResourceType, TagContext } from "./tags";

// Clients
export * as Aws from "./clients/index";

// Re-export useful utilities from AWS SDK
export { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
export type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";
