import { Effect } from "effect";
import { sqs, lambda } from "./clients";
import { toAwsTagList } from "./tags";

export type EnsureFifoQueueInput = {
  name: string;
  visibilityTimeout?: number;
  retentionPeriod?: number;
  contentBasedDeduplication?: boolean;
  tags?: Record<string, string>;
};

export type EnsureFifoQueueResult = {
  queueUrl: string;
  queueArn: string;
};

export const ensureFifoQueue = (input: EnsureFifoQueueInput) =>
  Effect.gen(function* () {
    const {
      name,
      visibilityTimeout = 30,
      retentionPeriod = 345600,
      contentBasedDeduplication = true,
      tags
    } = input;

    const queueName = `${name}.fifo`;

    // Check if queue already exists
    const existingUrl = yield* sqs.make("get_queue_url", {
      QueueName: queueName,
    }).pipe(
      Effect.map(result => result.QueueUrl),
      Effect.catchIf(
        (error) => error instanceof sqs.SQSError && error.cause.name === "QueueDoesNotExist",
        () => Effect.succeed(undefined)
      )
    );

    let queueUrl: string;

    if (!existingUrl) {
      yield* Effect.logDebug(`Creating FIFO queue ${queueName}...`);
      const result = yield* sqs.make("create_queue", {
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: String(contentBasedDeduplication),
          VisibilityTimeout: String(visibilityTimeout),
          MessageRetentionPeriod: String(retentionPeriod),
        },
        ...(tags ? { tags } : {}),
      });
      queueUrl = result.QueueUrl!;
    } else {
      yield* Effect.logDebug(`FIFO queue ${queueName} already exists`);
      queueUrl = existingUrl;

      // Update attributes if needed
      yield* sqs.make("set_queue_attributes", {
        QueueUrl: queueUrl,
        Attributes: {
          ContentBasedDeduplication: String(contentBasedDeduplication),
          VisibilityTimeout: String(visibilityTimeout),
          MessageRetentionPeriod: String(retentionPeriod),
        },
      });

      // Sync tags
      if (tags) {
        yield* sqs.make("tag_queue", {
          QueueUrl: queueUrl,
          Tags: tags,
        });
      }
    }

    // Get queue ARN
    const attrs = yield* sqs.make("get_queue_attributes", {
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    });
    const queueArn = attrs.Attributes?.QueueArn;
    if (!queueArn) {
      return yield* Effect.fail(new Error(`Could not resolve ARN for queue ${queueName}`));
    }

    return { queueUrl, queueArn } satisfies EnsureFifoQueueResult;
  });

export type EnsureSqsEventSourceMappingInput = {
  functionArn: string;
  queueArn: string;
  batchSize?: number;
  batchWindow?: number;
};

export const ensureSqsEventSourceMapping = (input: EnsureSqsEventSourceMappingInput) =>
  Effect.gen(function* () {
    const { functionArn, queueArn, batchSize = 10, batchWindow } = input;

    const existingMappings = yield* lambda.make("list_event_source_mappings", {
      FunctionName: functionArn,
      EventSourceArn: queueArn,
    });

    const existing = existingMappings.EventSourceMappings?.[0];

    if (existing) {
      yield* Effect.logDebug("Updating SQS event source mapping...");
      yield* lambda.make("update_event_source_mapping", {
        UUID: existing.UUID!,
        FunctionName: functionArn,
        BatchSize: batchSize,
        ...(batchWindow !== undefined ? { MaximumBatchingWindowInSeconds: batchWindow } : {}),
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        Enabled: true,
      });
      return existing.UUID!;
    }

    yield* Effect.logDebug("Creating SQS event source mapping...");
    const result = yield* lambda.make("create_event_source_mapping", {
      FunctionName: functionArn,
      EventSourceArn: queueArn,
      BatchSize: batchSize,
      ...(batchWindow !== undefined ? { MaximumBatchingWindowInSeconds: batchWindow } : {}),
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      Enabled: true,
    });

    return result.UUID!;
  });

export const deleteFifoQueue = (queueName: string) =>
  Effect.gen(function* () {
    const name = queueName.endsWith(".fifo") ? queueName : `${queueName}.fifo`;

    yield* Effect.logDebug(`Deleting SQS queue: ${name}`);

    const urlResult = yield* sqs.make("get_queue_url", {
      QueueName: name,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof sqs.SQSError && error.cause.name === "QueueDoesNotExist",
        () => {
          Effect.logDebug(`Queue ${name} not found, skipping`);
          return Effect.succeed(undefined);
        }
      )
    );

    if (urlResult?.QueueUrl) {
      yield* sqs.make("delete_queue", {
        QueueUrl: urlResult.QueueUrl,
      });
    }
  });
