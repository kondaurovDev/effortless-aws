import { ValidQueueMessage } from "~/__handlers/internal/sqs-types";
import { Effect } from "effect";

export const parseMessageJsonBody = (
  message: ValidQueueMessage
): Effect.Effect<unknown, Error> =>
  Effect.try({
    try: () => JSON.parse(message.body),
    catch: (e) => new Error(`Failed to parse JSON: ${e}`)
  })

export const getMessageAttribute = (
  message: ValidQueueMessage,
  attributeName: string
) =>
  message.messageAttributes?.[attributeName]?.stringValue;
