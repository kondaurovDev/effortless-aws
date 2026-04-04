import { Effect } from "effect";
import type { ExtractedWorkerFunction } from "~/build/bundle";
import { toSeconds } from "effortless-aws";
import { bundle, zip, resolveStaticFiles } from "~/build/bundle";
import {
  ensureCluster,
  ensureTaskDefinition,
  ensureService,
  ensureLogGroup,
  ensureEcsTaskRole,
  ensureEcsExecutionRole,
  getDefaultVpcSubnets,
  makeTags,
  resolveStage,
  type TagContext,
} from "../aws";
import { sqs, s3 } from "../aws/clients";
import type { DeployInput } from "./shared";

const fargateSizes: Record<string, [cpu: number, memory: number]> = {
  "0.25vCPU-512mb": [256, 512],
  "0.5vCPU-1gb": [512, 1024],
  "1vCPU-2gb": [1024, 2048],
  "2vCPU-4gb": [2048, 4096],
  "4vCPU-8gb": [4096, 8192],
};

function parseFargateSize(size: string): [cpu: number, memory: number] {
  const result = fargateSizes[size];
  if (!result) throw new Error(`Invalid Fargate size: ${size}`);
  return result;
}

export type DeployWorkerResult = {
  exportName: string;
  status: "created" | "updated";
  bundleSize?: number;
  clusterArn: string;
  serviceArn: string;
  queueUrl: string;
  taskDefinitionArn: string;
};

type DeployWorkerFunctionInput = {
  input: DeployInput;
  fn: ExtractedWorkerFunction;
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const WORKER_IMAGE = "kondaurov/effortless-aws-runner:latest";

/** @internal */
export const deployWorkerFunction = ({ input, fn, depsEnv, depsPermissions, staticGlobs }: DeployWorkerFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;
    const stage = resolveStage(input.stage);

    const tagCtx: TagContext = {
      project: input.project,
      stage,
      handler: handlerName,
    };
    const tags = makeTags(tagCtx);

    const clusterName = `${input.project}-${stage}`;
    const serviceName = `${input.project}-${stage}-${handlerName}`;
    const queueName = `${input.project}-${stage}-${handlerName}-worker`;
    const logGroupName = `/ecs/${serviceName}`;
    const s3Key = `effortless/${input.project}/${stage}/${handlerName}/worker.zip`;
    const s3Bucket = `${input.project}-${stage}-effortless`;

    const [cpu, memory] = parseFargateSize(config.size ?? "0.5vCPU-1gb");
    const idleTimeoutSec = config.idleTimeout ? toSeconds(config.idleTimeout) : 300;

    // 1. Create SQS queue (standard, not FIFO)
    yield* Effect.logDebug(`Creating SQS queue: ${queueName}`);
    const existingQueueUrl = yield* sqs.make("get_queue_url", {
      QueueName: queueName,
    }).pipe(
      Effect.map(r => r.QueueUrl),
      Effect.catchIf(
        (error) => error instanceof sqs.SQSError && error.cause.name === "QueueDoesNotExist",
        () => Effect.succeed(undefined)
      )
    );

    let queueUrl: string;
    if (!existingQueueUrl) {
      const result = yield* sqs.make("create_queue", {
        QueueName: queueName,
        Attributes: {
          VisibilityTimeout: "60",
          MessageRetentionPeriod: "345600", // 4 days
        },
        tags: makeTags(tagCtx),
      });
      queueUrl = result.QueueUrl!;
    } else {
      queueUrl = existingQueueUrl;
    }

    // 2. Bundle code (same pipeline as Lambda)
    yield* Effect.logDebug("Bundling worker code...");
    const { code } = yield* bundle({
      projectDir: input.projectDir,
      file: input.file,
      exportName: handlerName,
      type: "worker",
    });

    const resolved = staticGlobs && staticGlobs.length > 0
      ? yield* resolveStaticFiles(staticGlobs, input.projectDir)
      : undefined;

    const zipBuffer = yield* zip({
      content: code,
      ...(resolved?.files.length ? { staticFiles: resolved.files } : {}),
    });
    const bundleSize = zipBuffer.length;

    // 3. Ensure S3 bucket exists and upload ZIP
    yield* s3.make("create_bucket", {
      Bucket: s3Bucket,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof s3.S3Error && (
          error.cause.name === "BucketAlreadyOwnedByYou" ||
          error.cause.name === "BucketAlreadyExists"
        ),
        () => Effect.succeed(undefined)
      )
    );

    yield* s3.make("put_object", {
      Bucket: s3Bucket,
      Key: s3Key,
      Body: zipBuffer,
    });
    yield* Effect.logDebug(`Uploaded worker bundle to s3://${s3Bucket}/${s3Key}`);

    // 4. Ensure CloudWatch log group
    yield* ensureLogGroup(logGroupName);

    // 5. Ensure ECS cluster
    const clusterArn = yield* ensureCluster(clusterName, tags);

    // 6. Create IAM roles
    const taskPermissions = [
      // SQS: read messages from worker queue
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      // ECS: self-shutdown (scale to 0)
      "ecs:UpdateService",
      "ecs:DescribeServices",
      // S3: download code bundle
      "s3:GetObject",
      // CloudWatch Logs
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      ...(depsPermissions ?? []),
    ];

    const taskRoleArn = yield* ensureEcsTaskRole(
      input.project, stage, handlerName, taskPermissions, tags
    );

    const executionRoleArn = yield* ensureEcsExecutionRole(
      input.project, stage, tags
    );

    // 7. Register task definition
    const environment: Record<string, string> = {
      EFF_CODE_URL: `s3://${s3Bucket}/${s3Key}`,
      EFF_WORKER_QUEUE_URL: queueUrl,
      EFF_IDLE_TIMEOUT: String(idleTimeoutSec),
      EFF_CLUSTER: clusterName,
      EFF_SERVICE: serviceName,
      ...depsEnv,
    };

    const taskDefinitionArn = yield* ensureTaskDefinition({
      family: serviceName,
      containerName: handlerName,
      image: WORKER_IMAGE,
      memory,
      cpu,
      environment,
      taskRoleArn,
      executionRoleArn,
      logGroup: logGroupName,
      region: input.region,
      tags: tags,
    });

    // 8. Discover default VPC subnets
    const subnets = yield* getDefaultVpcSubnets(input.region);

    // 9. Create/update ECS service (starts with desiredCount: 0)
    const serviceArn = yield* ensureService({
      cluster: clusterName,
      serviceName,
      taskDefinitionArn,
      subnets,
      assignPublicIp: true,
      tags: tags,
    });

    yield* Effect.logDebug(`Worker deployment complete: ${serviceName}`);

    // 10. Update worker dep value for Lambda consumers
    // The dep value format: "queueUrl|cluster|service"
    // This is used by WorkerClient at runtime
    // We need to update the workerNameMap entry with the full dep value
    // This happens in deploy.ts after all workers are deployed

    return {
      exportName,
      status: "created" as const,
      bundleSize,
      clusterArn,
      serviceArn,
      queueUrl,
      taskDefinitionArn,
    };
  });
