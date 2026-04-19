// Lambda
export { ensureLambda, deleteLambda, publishVersion, ensureEdgePermission, ensureFunctionUrl, addFunctionUrlPublicAccess } from "./lambda";
export type { LambdaConfig, LambdaStatus } from "./lambda";

// IAM
export { ensureRole, ensureEdgeRole, ensureSchedulerRole, ensureEcsTaskRole, ensureEcsExecutionRole, deleteRole, listEffortlessRoles } from "./iam";
export type { EffortlessRole } from "./iam";

// DynamoDB
export { ensureTable, deleteTable, ensureEventSourceMapping } from "./dynamodb";
export type { EnsureTableInput, EnsureTableResult, EnsureEventSourceMappingInput, StreamView } from "./dynamodb";

// API Gateway
export { ensureProjectApi, addRouteToApi, removeStaleRoutes, deleteApi } from "./apigateway";
export type { ProjectApiConfig, RouteConfig, HttpMethod } from "./apigateway";

// Layer (AWS operations only)
export { ensureLayer, listLayerVersions, deleteAllLayerVersions, deleteLayerVersion } from "./layer";
export type { LayerConfig, LayerResult, LayerStatus, LayerVersionInfo } from "./layer";

// S3
export { ensureBucket, syncFiles, seedFiles, putObject, putBucketPolicyForOAC, emptyBucket, deleteBucket, ensureBucketNotification, clearBucketNotification, addS3LambdaPermission } from "./s3";
export type { EnsureBucketInput, SyncFilesInput, SyncFilesResult, SeedFilesResult, EnsureBucketNotificationInput } from "./s3";

// ACM
export { findCertificate } from "./acm";
export type { FindCertificateResult } from "./acm";

// CloudFront
export { ensureOAC, ensurePublicKey, ensureKeyGroup, ensureUrlRewriteFunction, ensureViewerRequestFunction, ensureDistribution, ensureSsrDistribution, invalidateDistribution, disableAndDeleteDistribution, deleteOAC, cleanupOrphanedFunctions, ensureApiCachePolicy, findDistributionByTags } from "./cloudfront";
export type { EnsureOACInput, EnsurePublicKeyInput, EnsureKeyGroupInput, EnsureDistributionInput, EnsureSsrDistributionInput, DistributionResult, ViewerRequestFunctionConfig } from "./cloudfront";

// VPC
export { getDefaultVpcSubnets } from "./vpc";

// ECS
export { ensureCluster, ensureTaskDefinition, ensureService, ensureLogGroup, deleteEcsService, deleteEcsCluster, deregisterTaskDefinitions, deleteLogGroup } from "./ecs";
export type { EnsureTaskDefinitionInput, EnsureServiceInput } from "./ecs";

// SQS
export { ensureFifoQueue, ensureStandardQueue, ensureSqsEventSourceMapping, deleteFifoQueue, deleteStandardQueue, getQueueMessageCount } from "./sqs";
export type { EnsureFifoQueueInput, EnsureFifoQueueResult, EnsureStandardQueueInput, EnsureSqsEventSourceMappingInput } from "./sqs";

// Scheduler
export { ensureSchedule, deleteSchedule, listSchedulesByPrefix } from "./scheduler";
export type { EnsureScheduleInput, EnsureScheduleResult } from "./scheduler";

// SES
export { ensureSesIdentity, deleteSesIdentity } from "./ses";
export type { EnsureSesIdentityInput, EnsureSesIdentityResult, DkimRecord } from "./ses";

// Resource lookup & tag utilities
export { toAwsTagList } from "./resource-lookup";

// Clients
export * as Aws from "./clients/index";

// Re-export useful types from AWS SDK
export type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";
