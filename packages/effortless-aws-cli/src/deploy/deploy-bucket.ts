import { Effect } from "effect";
import type { ExtractedBucketFunction } from "~/build/bundle";
import {
  ensureBucket,
  ensureBucketNotification,
  addS3LambdaPermission,
  makeTags,
  resolveStage,
  type TagContext,
} from "../aws";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

export type DeployBucketResult = {
  exportName: string;
  functionArn?: string;
  status: import("~/aws/lambda").LambdaStatus | "resource-only";
  bucketName: string;
  bucketArn: string;
};

type DeployBucketFunctionInput = {
  input: DeployInput;
  fn: ExtractedBucketFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const BUCKET_DEFAULT_PERMISSIONS = ["s3:*", "logs:*"] as const;

/** @internal */
export const deployBucketFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployBucketFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config, hasHandler } = fn;
    const handlerName = exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName,
    };

    // Create S3 bucket
    yield* Effect.logDebug("Creating S3 bucket...");
    const bucketName = `${input.project}-${tagCtx.stage}-${handlerName}`;
    const { bucketArn } = yield* ensureBucket({
      name: bucketName,
      region: input.region,
      tags: makeTags(tagCtx, "s3-bucket"),
    });

    // Resource-only mode: no Lambda, just the bucket
    if (!hasHandler) {
      yield* Effect.logDebug(`Bucket deployment complete (resource-only)! Bucket: ${bucketName}`);
      return {
        exportName,
        status: "resource-only" as const,
        bucketName,
        bucketArn,
      };
    }

    // Merge EFF_DEP_SELF (own bucket name) into deps env vars
    const selfEnv: Record<string, string> = { EFF_DEP_SELF: `bucket:${bucketName}`, ...depsEnv };

    // Deploy Lambda
    const { functionArn, status } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: BUCKET_DEFAULT_PERMISSIONS,
      bundleType: "bucket",
      ...(config.permissions ? { permissions: config.permissions } : {}),
      ...(config.memory ? { memory: config.memory } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      depsEnv: selfEnv,
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {}),
    });

    // Add Lambda permission for S3 to invoke the function
    yield* addS3LambdaPermission(functionArn, bucketName);

    // Configure S3 event notifications
    yield* ensureBucketNotification({
      bucketName,
      functionArn,
      events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
      prefix: config.prefix,
      suffix: config.suffix,
    });

    yield* Effect.logDebug(`Bucket deployment complete! Bucket: ${bucketName}`);

    return {
      exportName,
      functionArn,
      status,
      bucketName,
      bucketArn,
    };
  });
