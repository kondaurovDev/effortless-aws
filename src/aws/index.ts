// Lambda
export { ensureLambda, deleteLambda, publishVersion } from "./lambda";
export type { LambdaConfig, LambdaStatus } from "./lambda";

// IAM
export { ensureRole, ensureEdgeRole, deleteRole, listEffortlessRoles } from "./iam";
export type { EffortlessRole } from "./iam";

// DynamoDB
export { ensureTable, deleteTable, ensureEventSourceMapping } from "./dynamodb";
export type { EnsureTableInput, EnsureTableResult, EnsureEventSourceMappingInput, StreamView } from "./dynamodb";

// API Gateway
export { ensureProjectApi, addRouteToApi, removeStaleRoutes, deleteApi } from "./apigateway";
export type { ProjectApiConfig, RouteConfig, HttpMethod } from "./apigateway";

// Layer
export { ensureLayer, readProductionDependencies, computeLockfileHash, collectLayerPackages, listLayerVersions, deleteAllLayerVersions, deleteLayerVersion } from "./layer";
export type { LayerConfig, LayerResult, LayerStatus, LayerVersionInfo } from "./layer";

// S3
export { ensureBucket, syncFiles, putObject, putBucketPolicyForOAC, emptyBucket, deleteBucket, ensureBucketNotification, addS3LambdaPermission } from "./s3";
export type { EnsureBucketInput, SyncFilesInput, SyncFilesResult, EnsureBucketNotificationInput } from "./s3";

// ACM
export { findCertificate } from "./acm";
export type { FindCertificateResult } from "./acm";

// CloudFront
export { ensureOAC, ensureUrlRewriteFunction, ensureViewerRequestFunction, ensureDistribution, invalidateDistribution, disableAndDeleteDistribution, deleteOAC, cleanupOrphanedFunctions } from "./cloudfront";
export type { EnsureOACInput, EnsureDistributionInput, DistributionResult, ViewerRequestFunctionConfig } from "./cloudfront";

// SQS
export { ensureFifoQueue, ensureSqsEventSourceMapping, deleteFifoQueue } from "./sqs";
export type { EnsureFifoQueueInput, EnsureFifoQueueResult, EnsureSqsEventSourceMappingInput } from "./sqs";

// SES
export { ensureSesIdentity, deleteSesIdentity } from "./ses";
export type { EnsureSesIdentityInput, EnsureSesIdentityResult, DkimRecord } from "./ses";

// Tags
export { makeTags, toAwsTagList, resolveStage, getResourcesByTags, getAllResourcesByTags, findOrphanedResources, groupResourcesByHandler } from "./tags";
export type { ResourceType, TagContext } from "./tags";

// Clients
export * as Aws from "./clients/index";

// Re-export useful utilities from AWS SDK
export { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
export type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";
