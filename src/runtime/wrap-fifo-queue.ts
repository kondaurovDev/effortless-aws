import type { FifoQueueHandler, FifoQueueMessage } from "~/handlers/define-fifo-queue";
import { createHandlerRuntime } from "./handler-utils";

type SQSRecord = {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: {
    ApproximateReceiveCount?: string;
    SentTimestamp?: string;
    MessageGroupId?: string;
    MessageDeduplicationId?: string;
    ApproximateFirstReceiveTimestamp?: string;
  };
  messageAttributes: Record<string, { dataType?: string; stringValue?: string }>;
  md5OfBody?: string;
  eventSource?: string;
  eventSourceARN?: string;
};

type SQSEvent = {
  Records?: SQSRecord[];
};

type BatchItemFailure = {
  itemIdentifier: string;
};

const parseMessages = <T>(
  rawRecords: SQSRecord[],
  schema?: (input: unknown) => T
): FifoQueueMessage<T>[] => {
  const messages: FifoQueueMessage<T>[] = [];
  const decode = schema ?? ((x: unknown) => x as T);

  for (const record of rawRecords) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(record.body);
    } catch {
      parsedBody = record.body;
    }

    messages.push({
      messageId: record.messageId,
      receiptHandle: record.receiptHandle,
      body: decode(parsedBody),
      rawBody: record.body,
      messageGroupId: record.attributes.MessageGroupId ?? "",
      messageDeduplicationId: record.attributes.MessageDeduplicationId,
      messageAttributes: record.messageAttributes ?? {},
      approximateFirstReceiveTimestamp: record.attributes.ApproximateFirstReceiveTimestamp,
      approximateReceiveCount: record.attributes.ApproximateReceiveCount,
      sentTimestamp: record.attributes.SentTimestamp,
    });
  }

  return messages;
};

export const wrapFifoQueue = <T, C>(handler: FifoQueueHandler<T, C>) => {
  if (!handler.onMessage && !handler.onBatch) {
    throw new Error("wrapFifoQueue requires a handler with onMessage or onBatch defined");
  }

  const rt = createHandlerRuntime(handler, "fifo-queue", handler.__spec.logLevel ?? "info");
  const handleError = handler.onError ?? ((e: unknown) => console.error(`[effortless:${rt.handlerName}]`, e));

  return async (event: SQSEvent) => {
    const startTime = Date.now();
    rt.patchConsole();

    try {
      const rawRecords = event.Records ?? [];
      const input = { messageCount: rawRecords.length };

      let messages: FifoQueueMessage<T>[];
      try {
        messages = parseMessages<T>(rawRecords, handler.schema);
      } catch (error) {
        handleError(error);
        rt.logError(startTime, input, error);
        return {
          batchItemFailures: rawRecords.map(r => ({ itemIdentifier: r.messageId })),
        };
      }

      const shared = await rt.commonArgs();
      const batchItemFailures: BatchItemFailure[] = [];

      if (handler.onBatch) {
        try {
          await (handler.onBatch as any)({ messages, ...shared });
        } catch (error) {
          handleError(error);
          for (const message of messages) {
            batchItemFailures.push({ itemIdentifier: message.messageId });
          }
        }
      } else {
        const onMessage = handler.onMessage as any;
        for (const message of messages) {
          try {
            await onMessage({ message, ...shared });
          } catch (error) {
            handleError(error);
            batchItemFailures.push({ itemIdentifier: message.messageId });
          }
        }
      }

      if (batchItemFailures.length > 0) {
        rt.logError(startTime, input, `${batchItemFailures.length} message(s) failed`);
      } else {
        rt.logExecution(startTime, input, { processedCount: messages.length });
      }

      return { batchItemFailures };
    } finally {
      rt.restoreConsole();
    }
  };
};
