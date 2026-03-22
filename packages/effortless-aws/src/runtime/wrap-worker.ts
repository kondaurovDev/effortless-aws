import { SQS } from "@aws-sdk/client-sqs";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import type { WorkerHandler } from "../handlers/define-worker";
import { buildDeps, buildParams } from "./handler-utils";

/**
 * Wrap a WorkerHandler for execution inside a Fargate container.
 *
 * This is NOT a Lambda wrapper — it runs as a standalone Node.js process.
 * It polls SQS in batches, processes messages via onMessage with
 * concurrency control, and self-terminates after idle timeout
 * by scaling the ECS service to 0.
 */
export const wrapWorker = <T, C>(handler: WorkerHandler<T, C>) => {
  return async () => {
    const queueUrl = process.env.EFF_WORKER_QUEUE_URL;
    if (!queueUrl) throw new Error("Missing EFF_WORKER_QUEUE_URL env var");

    const cluster = process.env.EFF_CLUSTER;
    const service = process.env.EFF_SERVICE;
    const idleTimeoutSec = process.env.EFF_IDLE_TIMEOUT
      ? Number(process.env.EFF_IDLE_TIMEOUT)
      : 300; // default 5m

    const concurrency = Math.min(Math.max((handler.__spec as any).concurrency ?? 1, 1), 10);

    const sqs = new SQS({});
    const ecs = new ECSClient({});

    // Build deps & config (same as Lambda wrappers)
    const deps = buildDeps(handler.deps);
    const config = await buildParams(handler.config as Record<string, unknown> | undefined);

    // Run setup if defined
    let ctx: Record<string, unknown> = {};
    if (handler.setup) {
      const setupArgs: Record<string, unknown> = {};
      if (deps) setupArgs.deps = deps;
      if (config) setupArgs.config = config;
      const result = await handler.setup(setupArgs);
      if (result && typeof result === "object") ctx = result as Record<string, unknown>;
    }

    const onMessage = handler.onMessage as ((msg: T, ctx: any) => Promise<void> | void) | undefined;
    if (!onMessage) throw new Error("Worker has no onMessage handler");

    const onError = handler.onError as
      | ((args: { error: unknown; msg: T; retryCount: number } & Record<string, unknown>) => "retry" | "delete" | void)
      | undefined;

    let lastMessageAt = Date.now();

    try {
      // Polling loop
      while (true) {
        const resp = await sqs.receiveMessage({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: concurrency,
          WaitTimeSeconds: 20,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        });

        const messages = resp?.Messages;
        if (!messages || messages.length === 0) {
          // Check idle timeout
          if (Date.now() - lastMessageAt > idleTimeoutSec * 1000) {
            console.log("[effortless:worker] Idle timeout reached, shutting down...");
            break;
          }
          continue;
        }

        lastMessageAt = Date.now();

        // Process batch with Promise.allSettled
        const results = await Promise.allSettled(
          messages.map(async (sqsMsg) => {
            const parsed = JSON.parse(sqsMsg.Body ?? "null") as T;
            await onMessage(parsed, ctx);
            return sqsMsg.ReceiptHandle!;
          })
        );

        // Partial batch: delete successful, handle failures
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const sqsMsg = messages[i]!;

          if (result.status === "fulfilled") {
            await sqs.deleteMessage({
              QueueUrl: queueUrl,
              ReceiptHandle: result.value,
            });
          } else {
            const retryCount = Number(sqsMsg.Attributes?.ApproximateReceiveCount ?? "1");
            const parsed = JSON.parse(sqsMsg.Body ?? "null") as T;

            let action: "retry" | "delete" | void = "retry";
            if (onError) {
              try {
                action = onError({ error: result.reason, msg: parsed, retryCount, ...ctx });
              } catch (e) {
                console.error("[effortless:worker] onError threw", e);
              }
            } else {
              console.error("[effortless:worker]", result.reason);
            }

            if (action === "delete") {
              await sqs.deleteMessage({
                QueueUrl: queueUrl,
                ReceiptHandle: sqsMsg.ReceiptHandle!,
              });
            }
            // "retry" or void — leave in queue, SQS returns after visibility timeout
          }
        }
      }
    } finally {
      // Cleanup
      if (handler.onCleanup) {
        try { await handler.onCleanup(ctx); }
        catch (e) { console.error("[effortless:worker] onCleanup error", e); }
      }

      // Scale service to 0
      if (cluster && service) {
        try {
          await ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount: 0 }));
          console.log("[effortless:worker] Scaled service to 0");
        } catch (e) {
          console.error("[effortless:worker] Failed to scale down", e);
        }
      }

      process.exit(0);
    }
  };
};
