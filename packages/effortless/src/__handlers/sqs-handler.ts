import { Effect, Layer, ManagedRuntime, pipe, Match, Logger } from "effect";
import * as S from "effect/Schema";
import { LogLevelConfigFromEnv } from "./internal/log-level";

import { PartialBatchResponse, FailedBatchItem, ValidMessage, InputBatchMessages, ResultOfProcessedBatch } from "./internal/types";
import { SQSBatchEvent, ValidQueueMessage } from "./internal/sqs-types";

export const createQueueBatchHandler = <M, E, R>(
  input: Pick<QueueBatchHandler<M, E, R>, "handle" | "live" | "parse">
): QueueBatchHandler<M, E, R> => ({
  ...input,
  type: "QueueBatchHandler"
})

export const createQueueBatchSerialHandler = <M, E, R>(
  input: Pick<QueueBatchSerialHandler<M, E, R>, "handle" | "live" | "parse">
): QueueBatchSerialHandler<M, E, R> => ({
  ...input,
  type: "QueueBatchSerialHandler"
})

type QueueHandlerProperties<M, E, R> = {
  parse: (_: ValidQueueMessage) => Effect.Effect<M, E, R>
  live: Layer.Layer<R, unknown, never>
}

export type QueueBatchHandler<M, E, R> = {
  type: "QueueBatchHandler"
  handle: (_: ValidMessage<M>[]) => Effect.Effect<FailedBatchItem[], never, R>
} & QueueHandlerProperties<M, E, R>

export type QueueBatchSerialHandler<M, E, R> = {
  type: "QueueBatchSerialHandler"
  handle: (_: M, __: ValidQueueMessage) => Effect.Effect<unknown, unknown, R>
} & QueueHandlerProperties<M, E, R>

export type QueueOneOfBatchHandler<M, E, R> =
  QueueBatchHandler<M, E, R> | QueueBatchSerialHandler<M, E, R>

// https://docs.aws.amazon.com/prescriptive-guidance/latest/lambda-event-filtering-partial-batch-responses-for-sqs/best-practices-partial-batch-responses.html

export const handleBatchOfMessages = <M, R>(
  batch: ValidMessage<M>[],
  handle: (_: ValidMessage<M>[]) => Effect.Effect<FailedBatchItem[], never, R>
) =>
  pipe(
    handle(batch),
    Effect.catchAllCause(error =>
      pipe(
        Effect.logWarning("batch handling error", error),
        Effect.andThen(() =>
          batch.map(_ => FailedBatchItem({ itemIdentifier: _.origin.receiptHandle }))
        )
      )
    )
  )

export const handleBatchOneByOne = <M, R>(
  batch: ValidMessage<M>[],
  handle: (_: M, __: ValidQueueMessage) => Effect.Effect<unknown, unknown, R>
) =>
  Effect.reduce(
    batch,
    [] as FailedBatchItem[],
    (accum, oneMessage) =>
      pipe(
        handle(oneMessage.message, oneMessage.origin),
        Effect.andThen(() => accum),
        Effect.catchAllCause(error =>
          pipe(
            Effect.logWarning("event handling error", { message: oneMessage.message, error }),
            Effect.andThen(() => {
              accum.push(FailedBatchItem({ itemIdentifier: oneMessage.origin.receiptHandle }));
              return accum;
            })
          ),
        )
      )
  )

export const createLambdaHandler = <M, E, R>(
  queueHandler: QueueOneOfBatchHandler<M, E, R>
) => {
  const runtime =
    ManagedRuntime.make(
      Layer.mergeAll(
        Logger.json,
        LogLevelConfigFromEnv,
        queueHandler.live
      )
    )

  return (input: unknown) =>

    Effect.gen(function* () {

      yield* Effect.logDebug("input batch", input)

      const inputBatch =
        yield* S.decodeUnknown(SQSBatchEvent)(input);

      const inputMessages =
        yield* Effect.reduce(
          inputBatch.Records,
          new InputBatchMessages<M, E>({ invalid: [], valid: [] }),
          (accum, record) =>
            pipe(
              queueHandler.parse(record),
              Effect.match({
                onFailure: error => {
                  console.log("Skipping wrong input", record, error);
                  accum.invalid.push({
                    message: record, reason: error
                  });
                  return accum;
                },
                onSuccess: (value) => {
                  accum.valid.push({
                    message: value,
                    origin: record
                  })
                  return accum;
                }
              })
            )
        );

      const result =
        yield* pipe(
          Match.value(queueHandler),
          Match.when(({ type: "QueueBatchSerialHandler" }), handler =>
            handleBatchOneByOne(inputMessages.valid, handler.handle)
          ),
          Match.when(({ type: "QueueBatchHandler" }), handler =>
            handleBatchOfMessages(inputMessages.valid, handler.handle)
          ),
          Match.exhaustive
        );

      const batchResult =
        ResultOfProcessedBatch({
          incoming: inputBatch.Records.length,
          valid: inputMessages.valid.length,
          failed: result.length,
          successful: inputMessages.valid.length - result.length
        });

      yield* Effect.logInfo(
        "batch result handled",
        batchResult
      )

      const partialResponse =
        PartialBatchResponse({
          batchItemFailures: result
        })

      return partialResponse;
    }).pipe(
      runtime.runPromise
    )
}
