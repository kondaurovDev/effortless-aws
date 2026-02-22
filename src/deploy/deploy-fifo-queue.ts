import { Effect } from "effect";
import type { ExtractedFifoQueueFunction } from "~/build/bundle";
import {
  ensureFifoQueue,
  ensureSqsEventSourceMapping,
  makeTags,
  resolveStage,
  type TagContext,
} from "../aws";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

export type DeployFifoQueueResult = {
  exportName: string;
  functionArn: string;
  status: import("~/aws/lambda").LambdaStatus;
  queueUrl: string;
  queueArn: string;
};

type DeployFifoQueueFunctionInput = {
  input: DeployInput;
  fn: ExtractedFifoQueueFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const FIFO_QUEUE_DEFAULT_PERMISSIONS = ["sqs:*", "logs:*"] as const;

/** @internal */
export const deployFifoQueueFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployFifoQueueFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName,
    };

    // Create SQS FIFO queue
    yield* Effect.logDebug("Creating SQS FIFO queue...");
    const queueName = `${input.project}-${tagCtx.stage}-${handlerName}`;
    const timeout = config.timeout ?? 30;
    const { queueUrl, queueArn } = yield* ensureFifoQueue({
      name: queueName,
      visibilityTimeout: Math.max(config.visibilityTimeout ?? timeout, timeout),
      retentionPeriod: config.retentionPeriod,
      contentBasedDeduplication: config.contentBasedDeduplication ?? true,
      tags: makeTags(tagCtx, "sqs"),
    });

    // Inject queue URL/ARN into Lambda env vars
    const queueEnv: Record<string, string> = {
      EFF_QUEUE_URL: queueUrl,
      EFF_QUEUE_ARN: queueArn,
      ...depsEnv,
    };

    // Deploy Lambda
    const { functionArn, status } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: FIFO_QUEUE_DEFAULT_PERMISSIONS,
      bundleType: "fifoQueue",
      ...(config.permissions ? { permissions: config.permissions } : {}),
      ...(config.memory ? { memory: config.memory } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      depsEnv: queueEnv,
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {}),
    });

    // Setup event source mapping (SQS -> Lambda)
    yield* Effect.logDebug("Setting up SQS event source mapping...");
    yield* ensureSqsEventSourceMapping({
      functionArn,
      queueArn,
      batchSize: config.batchSize ?? 10,
      batchWindow: config.batchWindow,
    });

    yield* Effect.logDebug(`FIFO queue deployment complete! Queue: ${queueUrl}`);

    return {
      exportName,
      functionArn,
      status,
      queueUrl,
      queueArn,
    };
  });
