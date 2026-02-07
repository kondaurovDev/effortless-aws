import { Brand, Data, ParseResult } from "effect";

import { ReceiptHandle, ValidQueueMessage } from "./sqs-types";

export class InputBatchMessages<A, E>
  extends Data.Class<{
    valid: ValidMessage<A>[],
    invalid: InvalidMessage<E>[]
  }> { }

export type FailedBatchItem = {
  itemIdentifier: ReceiptHandle
} & Brand.Brand<"FailedBatchItem">

export const FailedBatchItem = Brand.nominal<FailedBatchItem>();

export type PartialBatchResponse = {
  batchItemFailures: FailedBatchItem[]
} & Brand.Brand<"PartialBatchResponse">

export const PartialBatchResponse = Brand.nominal<PartialBatchResponse>();

export class ValidMessage<A>
  extends Data.Class<{
    origin: ValidQueueMessage,
    message: A
  }> { }

export class InvalidMessage<E>
  extends Data.Class<{
    message: ValidQueueMessage,
    reason: E | ParseResult.ParseError
  }> { }

export type ResultOfProcessedBatch =
  Brand.Branded<{
    incoming: number, valid: number, successful: number, failed: number
  }, "ResultOfProcessedBatch">

export const ResultOfProcessedBatch = Brand.nominal<ResultOfProcessedBatch>()
