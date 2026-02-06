import { Effect, Layer, ManagedRuntime } from "effect";
import * as S from "effect/Schema";
import { LogLevelConfigFromEnv } from "./internal/log-level";

import { DDbStreamRecord, DDbBatchStreamEvent } from "./models/dynamodb-stream";
import { FailedBatchItem, PartialBatchResponse } from "./internal/types";
import { ReceiptHandle } from "./internal/sqs-types";

type StreamHandlerProperties<R> = {
  live: Layer.Layer<R, unknown, never>
}

export type StreamBatchHandler<R> = {
  type: "StreamBatchHandler"
  handle: (_: readonly DDbStreamRecord[]) => Effect.Effect<FailedBatchItem[], never, R>
} & StreamHandlerProperties<R>

export type StreamBatchSerialHandler<R> = {
  type: "StreamBatchSerialHandler"
  handle: (_: DDbStreamRecord) => Effect.Effect<void, unknown, R>
} & StreamHandlerProperties<R>

export type StreamOneOfBatchHandler<R> =
  StreamBatchHandler<R> | StreamBatchSerialHandler<R>

export const createStreamBatchHandler = <R>(
  input: Pick<StreamBatchHandler<R>, "handle" | "live">
): StreamBatchHandler<R> => ({
  ...input,
  type: "StreamBatchHandler"
})

export const createStreamBatchSerialHandler = <R>(
  input: Pick<StreamBatchSerialHandler<R>, "handle" | "live">
): StreamBatchSerialHandler<R> => ({
  ...input,
  type: "StreamBatchSerialHandler"
})

export const handleStreamBatch = <R>(
  batch: readonly DDbStreamRecord[],
  handle: (_: readonly DDbStreamRecord[]) => Effect.Effect<FailedBatchItem[], never, R>
) =>
  handle(batch).pipe(
    Effect.catchAllCause(error =>
      Effect.zipRight(
        Effect.logWarning("stream handling error", error),
        Effect.succeed(batch.map(record => FailedBatchItem({
          itemIdentifier: ReceiptHandle.make(record.dynamodb.SequenceNumber)
        })))
      )
    )
  )

export const handleStreamBatchSequentially = <E, R>(
  batch: readonly DDbStreamRecord[],
  handle: (_: DDbStreamRecord) => Effect.Effect<unknown, E, R>
) =>
  Effect.reduce(
    batch,
    [] as FailedBatchItem[],
    (failures, record) =>
      handle(record).pipe(
        Effect.as(failures),
        Effect.catchAllCause(error =>
          Effect.zipRight(
            Effect.logWarning("event handling error", { record, error }),
            Effect.succeed([...failures, FailedBatchItem({ itemIdentifier: record.dynamodb.SequenceNumber })])
          )
        )
      )
  )

export const createLambdaHandler = <R>(
  streamHandler: StreamOneOfBatchHandler<R>
) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(streamHandler.live, LogLevelConfigFromEnv)
  )

  const processRecords = (records: readonly DDbStreamRecord[]) =>
    streamHandler.type === "StreamBatchSerialHandler"
      ? handleStreamBatchSequentially(records, streamHandler.handle)
      : handleStreamBatch(records, streamHandler.handle)

  return (input: unknown) =>
    S.decodeUnknown(DDbBatchStreamEvent)(input).pipe(
      Effect.andThen(batch => processRecords(batch.Records)),
      Effect.andThen(failures => PartialBatchResponse({ batchItemFailures: failures })),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(PartialBatchResponse({ batchItemFailures: [] }))
      ),
      runtime.runPromise
    )
}
