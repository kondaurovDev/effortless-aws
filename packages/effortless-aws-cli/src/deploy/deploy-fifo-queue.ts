import { Effect } from "effect";
import type { ExtractedFifoQueueFunction } from "~/discovery";
import { toSeconds } from "effortless-aws";
import { ensureFifoQueue, ensureSqsEventSourceMapping } from "../aws";
import { makeTags, resolveStage, type TagContext } from "../core";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

export type DeployFifoQueueResult = {
  exportName: string;
  functionArn: string;
  status: import("~/aws/lambda").LambdaStatus;
  bundleSize?: number;
  queueUrl: string;
  queueArn: string;
  dlqUrl: string;
  dlqArn: string;
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
    const timeout = toSeconds(config.lambda?.timeout ?? 30);
    const { queueUrl, queueArn, dlqUrl, dlqArn } = yield* ensureFifoQueue({
      name: queueName,
      visibilityTimeout: Math.max(config.visibilityTimeout ? toSeconds(config.visibilityTimeout) : timeout, timeout),
      retentionPeriod: config.retentionPeriod ? toSeconds(config.retentionPeriod) : undefined,
      delay: config.delay ? toSeconds(config.delay) : undefined,
      contentBasedDeduplication: config.contentBasedDeduplication ?? true,
      maxReceiveCount: config.maxReceiveCount,
      tags: makeTags(tagCtx),
    });

    // Inject queue URL/ARN into Lambda env vars
    const queueEnv: Record<string, string> = {
      EFF_QUEUE_URL: queueUrl,
      EFF_QUEUE_ARN: queueArn,
      ...depsEnv,
    };

    // Deploy Lambda
    const { functionArn, status, bundleSize } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: FIFO_QUEUE_DEFAULT_PERMISSIONS,
      bundleType: "fifoQueue",
      ...(config.lambda?.permissions ? { permissions: config.lambda.permissions } : {}),
      ...(config.lambda?.memory ? { memory: config.lambda.memory } : {}),
      ...(config.lambda?.timeout ? { timeout: toSeconds(config.lambda.timeout) } : {}),
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
      batchWindow: config.batchWindow ? toSeconds(config.batchWindow) : undefined,
    });

    yield* Effect.logDebug(`FIFO queue deployment complete! Queue: ${queueUrl}`);

    return {
      exportName,
      functionArn,
      status,
      bundleSize,
      queueUrl,
      queueArn,
      dlqUrl,
      dlqArn,
    };
  });
