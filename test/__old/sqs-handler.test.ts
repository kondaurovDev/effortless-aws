import { describe, it, expect } from "vitest"
import { Effect, Layer, Match, pipe } from "effect";
import * as S from "effect/Schema";

import { createLambdaHandler } from "../../src/__handlers/sqs-handler";
import { FailedBatchItem, PartialBatchResponse } from "../../src/__handlers/internal/types";
import { ReceiptHandle } from "../../src/__handlers/internal/sqs-types";

process.env["LOG_LEVEL"] = "debug";

const lambdaHandler =
  createLambdaHandler({
    type: "QueueBatchSerialHandler",
    parse: (message) =>
      S.validate(S.NonEmptyString.pipe(S.startsWith("msg")))(message.body),
    handle: (input) =>
      pipe(
        Match.value(input),
        Match.when("msg1", () => Effect.succeed("some res")),
        Match.when("msg2", () => Effect.succeed("blaa")),
        Match.orElse(() => Effect.fail(Error("some error"))),
      ),
    live: Layer.empty
  });

describe("sqs batch handler", () => {

  it("should provide a successful response", async () => {

    const actual =
      await lambdaHandler({
        Records: [
          { body: "msg1", receiptHandle: "handle1", messageId: "1" },
          { body: "msg2", receiptHandle: "handle2", messageId: "2" },
          { body: "msg3", receiptHandle: "handle3", messageId: "3" },
          { body: "command1", receiptHandle: "handle4", messageId: "4" },
        ]
      })

    expect(actual).toEqual(
      PartialBatchResponse({
        batchItemFailures: [
          FailedBatchItem({ itemIdentifier: ReceiptHandle.make("handle3") })
        ]
      })
    );
  });

})
