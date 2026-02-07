import * as S from "effect/Schema";

import { ReceiptHandle } from "~/__handlers/internal/sqs-types";

export type DDbBatchStreamEvent =
  typeof DDbBatchStreamEvent.Type

export const DDbBatchStreamEvent =
  S.Struct({
    Records: S.Array(S.suspend(() => DDbStreamRecord))
  });

export type DDbStreamRecord = typeof DDbStreamRecord.Type

// http://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_StreamRecord.html
export const DDbStreamRecord =
  S.Struct({
    dynamodb:
      S.Struct({
        ApproximateCreationDateTime: S.Number,
        SequenceNumber: ReceiptHandle,
        Keys: S.Object,
        NewImage: S.optional(S.Object),
        OldImage: S.optional(S.Object),
        StreamViewType: S.Literal("KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"),
      })
  })
