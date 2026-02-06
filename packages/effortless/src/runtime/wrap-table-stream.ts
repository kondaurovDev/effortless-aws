import { unmarshall } from "@effect-ak/effortless-aws";
import type { TableHandler, TableRecord, FailedRecord } from "../handlers/define-table";

type DynamoDBStreamRecord = {
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    NewImage?: Record<string, any>;
    OldImage?: Record<string, any>;
    Keys?: Record<string, any>;
    SequenceNumber?: string;
    ApproximateCreationDateTime?: number;
  };
};

type DynamoDBStreamEvent = {
  Records?: DynamoDBStreamRecord[];
};

type BatchItemFailure = {
  itemIdentifier: string;
};

export const wrapTableStream = <T, C, R>(handler: TableHandler<T, C, R>) => {
  if (!handler.onRecord) {
    throw new Error("wrapTableStream requires a handler with onRecord defined");
  }

  let deps: C | null = null;
  
  const getDeps = () => (deps ??= handler.context?.() as C);

  return async (event: DynamoDBStreamEvent) => {
    const rawRecords = event.Records ?? [];
    const batchItemFailures: BatchItemFailure[] = [];
    const results: R[] = [];
    const failures: FailedRecord<T>[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRecord = handler.onRecord as any;

    for (const rawRecord of rawRecords) {
      if (!rawRecord.dynamodb?.Keys) continue;

      const record = {
        eventName: rawRecord.eventName,
        new: rawRecord.dynamodb?.NewImage ? (unmarshall(rawRecord.dynamodb.NewImage) as T) : undefined,
        old: rawRecord.dynamodb?.OldImage ? (unmarshall(rawRecord.dynamodb.OldImage) as T) : undefined,
        keys: unmarshall(rawRecord.dynamodb.Keys),
        sequenceNumber: rawRecord.dynamodb?.SequenceNumber,
        timestamp: rawRecord.dynamodb?.ApproximateCreationDateTime,
      } as TableRecord<T>;

      try {
        const result = handler.context
          ? await onRecord({ record, ctx: getDeps() })
          : await onRecord({ record });

        if (result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        failures.push({ record, error });
        if (rawRecord.dynamodb?.SequenceNumber) {
          batchItemFailures.push({ itemIdentifier: rawRecord.dynamodb.SequenceNumber });
        }
      }
    }

    if (handler.onBatchComplete) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onBatchComplete = handler.onBatchComplete as any;
        handler.context
          ? await onBatchComplete({ results, failures, ctx: getDeps() })
          : await onBatchComplete({ results, failures });
      } catch {
        for (const rawRecord of rawRecords) {
          if (rawRecord.dynamodb?.SequenceNumber) {
            const alreadyFailed = batchItemFailures.some(
              (f) => f.itemIdentifier === rawRecord.dynamodb?.SequenceNumber
            );
            if (!alreadyFailed) {
              batchItemFailures.push({ itemIdentifier: rawRecord.dynamodb.SequenceNumber });
            }
          }
        }
      }
    }

    return { batchItemFailures };
  };
};
