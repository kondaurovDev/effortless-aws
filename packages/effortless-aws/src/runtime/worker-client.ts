import { SQS } from "@aws-sdk/client-sqs";
import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import type { Duration } from "../handlers/handler-options";
import { toSeconds } from "../handlers/handler-options";

/** Options for sending a message to a worker */
export type WorkerSendOptions = {
  /** Delay before the message becomes visible in the queue (max "15m") */
  delay?: Duration;
  /** Whether to start the worker container (default: true) */
  start?: boolean;
};

export type WorkerClient<T = unknown> = {
  /** Send a message to the worker's queue. Wakes up the worker by default. */
  send(msg: T, options?: WorkerSendOptions): Promise<void>;
  /** Check if the worker is currently running */
  status(): Promise<"running" | "idle">;
  /** Stop the worker (scale ECS service to 0) */
  stop(): Promise<void>;
};

/**
 * Creates a typed WorkerClient for a Fargate worker.
 * Lazily initializes SQS and ECS SDK clients (cold start friendly).
 *
 * Dep value format: "workerName:idleTimeoutSec" (e.g. "my-project-dev-myWorker:300")
 * Queue name convention: "${workerName}-worker"
 * Cluster convention: derived from project-stage prefix of workerName
 *
 * @param depValue - The resolved dep value: "${project}-${stage}-${exportName}:${idleTimeoutSec}"
 */
export const createWorkerClient = <T = unknown>(depValue: string): WorkerClient<T> => {
  // Parse "workerName:idleTimeoutSec"
  const lastColon = depValue.lastIndexOf(":");
  const workerName = depValue.slice(0, lastColon);
  const idleTimeoutMs = Number(depValue.slice(lastColon + 1)) * 1000;

  const queueName = `${workerName}-worker`;
  // Cluster = project-stage (workerName without last segment = handlerName)
  const cluster = workerName.replace(/-[^-]+$/, "");
  const service = workerName;

  let sqsClient: SQS | null = null;
  const getSqs = () => (sqsClient ??= new SQS({}));

  let ecsClient: ECSClient | null = null;
  const getEcs = () => (ecsClient ??= new ECSClient({}));

  // Lazily resolve queue URL from queue name
  let resolvedQueueUrl: string | undefined;
  const getQueueUrl = async (): Promise<string> => {
    if (resolvedQueueUrl) return resolvedQueueUrl;
    const result = await getSqs().getQueueUrl({ QueueName: queueName });
    resolvedQueueUrl = result.QueueUrl!;
    return resolvedQueueUrl;
  };

  // Cache: once awake, skip ECS checks for idleTimeout duration
  let awakeUntil = 0;

  const ensureRunning = async () => {
    if (Date.now() < awakeUntil) return;
    const resp = await getEcs().send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = resp.services?.[0];
    if (svc && svc.desiredCount === 0) {
      await getEcs().send(new UpdateServiceCommand({ cluster, service, desiredCount: 1 }));
    }
    awakeUntil = Date.now() + idleTimeoutMs;
  };

  return {
    async send(msg: T, options?: WorkerSendOptions) {
      const queueUrl = await getQueueUrl();
      await getSqs().sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(msg),
        ...(options?.delay ? { DelaySeconds: toSeconds(options.delay) } : {}),
      });
      if (options?.start !== false && !options?.delay) {
        await ensureRunning();
      }
    },

    async status() {
      const resp = await getEcs().send(new DescribeServicesCommand({ cluster, services: [service] }));
      const svc = resp.services?.[0];
      if (svc && svc.runningCount && svc.runningCount > 0) return "running";
      return "idle";
    },

    async stop() {
      await getEcs().send(new UpdateServiceCommand({ cluster, service, desiredCount: 0 }));
      awakeUntil = 0;
    },
  };
};
