import { SQS } from "@aws-sdk/client-sqs";

/**
 * Input for QueueClient.send()
 */
export type SendMessageInput<T> = {
  /** Message body (serialized as JSON) */
  body: T;
  /** Message group ID (FIFO ordering key) */
  groupId: string;
  /** Message deduplication ID. Required if content-based deduplication is disabled. */
  deduplicationId?: string;
  /** Optional message attributes */
  messageAttributes?: Record<string, { dataType: string; stringValue: string }>;
};

/**
 * Typed SQS FIFO queue client for sending messages.
 *
 * @typeParam T - Type of the message body (serialized as JSON)
 */
export type QueueClient<T = unknown> = {
  /** Send a single message to the FIFO queue */
  send(input: SendMessageInput<T>): Promise<void>;
  /** Send a batch of messages (up to 10) to the FIFO queue */
  sendBatch(messages: SendMessageInput<T>[]): Promise<void>;
  /** The SQS queue name (without .fifo suffix) */
  queueName: string;
};

/**
 * Creates a typed QueueClient for an SQS FIFO queue.
 * Lazily initializes the SQS SDK client and resolves the queue URL on first use (cold start friendly).
 */
export const createQueueClient = <T = unknown>(queueName: string): QueueClient<T> => {
  let client: SQS | null = null;
  const getClient = () => (client ??= new SQS({}));

  let resolvedUrl: string | undefined;
  const getQueueUrl = async (): Promise<string> => {
    if (resolvedUrl) return resolvedUrl;
    const result = await getClient().getQueueUrl({ QueueName: `${queueName}.fifo` });
    resolvedUrl = result.QueueUrl!;
    return resolvedUrl;
  };

  return {
    queueName,

    async send(input: SendMessageInput<T>) {
      const queueUrl = await getQueueUrl();
      await getClient().sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(input.body),
        MessageGroupId: input.groupId,
        ...(input.deduplicationId ? { MessageDeduplicationId: input.deduplicationId } : {}),
        ...(input.messageAttributes ? {
          MessageAttributes: Object.fromEntries(
            Object.entries(input.messageAttributes).map(([k, v]) => [k, {
              DataType: v.dataType,
              StringValue: v.stringValue,
            }])
          ),
        } : {}),
      });
    },

    async sendBatch(messages: SendMessageInput<T>[]) {
      const queueUrl = await getQueueUrl();
      const entries = messages.map((msg, i) => ({
        Id: String(i),
        MessageBody: JSON.stringify(msg.body),
        MessageGroupId: msg.groupId,
        ...(msg.deduplicationId ? { MessageDeduplicationId: msg.deduplicationId } : {}),
      }));
      const result = await getClient().sendMessageBatch({
        QueueUrl: queueUrl,
        Entries: entries,
      });
      if (result.Failed && result.Failed.length > 0) {
        throw new Error(`Failed to send ${result.Failed.length} message(s): ${result.Failed.map((f: { Message?: string }) => f.Message).join(", ")}`);
      }
    },
  };
};
