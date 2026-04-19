import { Effect } from "effect";
import type { ExtractedQueueFunction } from "~/discovery";
import { toSeconds } from "effortless-aws";
import { ensureFifoQueue, ensureSqsEventSourceMapping } from "../aws";
import { makeTags, resolveStage, type TagContext } from "../core";
import { cleanupStaleHandlerResources } from "./resource-registry";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

export type DeployQueueResult = {
  exportName: string;
  functionArn?: string;
  status: import("~/aws/lambda").LambdaStatus | "unchanged";
  bundleSize?: number;
  queueUrl: string;
  queueArn: string;
  dlqUrl: string;
  dlqArn: string;
};

type DeployQueueFunctionInput = {
  input: DeployInput;
  fn: ExtractedQueueFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const QUEUE_DEFAULT_PERMISSIONS = ["sqs:*", "logs:*"] as const;

/** @internal */
export const deployQueueFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployQueueFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config, hasHandler } = fn;
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

    // Resource-only mode: queue is consumed by an external system, no Lambda
    if (!hasHandler) {
      yield* cleanupStaleHandlerResources("queue", {
        project: input.project,
        stage: tagCtx.stage,
        handler: handlerName,
        region: input.region,
      });
      yield* Effect.logDebug(`Queue deployment complete (resource-only)! Queue: ${queueUrl}`);
      return {
        exportName,
        status: "unchanged" as const,
        queueUrl,
        queueArn,
        dlqUrl,
        dlqArn,
      };
    }

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
      defaultPermissions: QUEUE_DEFAULT_PERMISSIONS,
      bundleType: "queue",
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
      batchSize: config.poller?.batchSize ?? 10,
      batchWindow: config.poller?.batchWindow ? toSeconds(config.poller.batchWindow) : undefined,
    });

    yield* Effect.logDebug(`Queue deployment complete! Queue: ${queueUrl}`);

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
