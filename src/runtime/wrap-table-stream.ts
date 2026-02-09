import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { TableHandler, TableRecord, FailedRecord } from "~/handlers/define-table";
import { createTableClient } from "./table-client";
import { createHandlerRuntime } from "./handler-utils";
import { truncateForStorage } from "./platform-types";

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

const parseRecords = <T>(rawRecords: DynamoDBStreamRecord[], schema?: (input: unknown) => T): { records: TableRecord<T>[]; sequenceNumbers: Map<TableRecord<T>, string> } => {
  const records: TableRecord<T>[] = [];
  const sequenceNumbers = new Map<TableRecord<T>, string>();
  const decode = schema ?? ((x: unknown) => x as T);

  for (const rawRecord of rawRecords) {
    if (!rawRecord.dynamodb?.Keys) continue;

    const newImage = rawRecord.dynamodb?.NewImage ? unmarshall(rawRecord.dynamodb.NewImage) : undefined;
    const oldImage = rawRecord.dynamodb?.OldImage ? unmarshall(rawRecord.dynamodb.OldImage) : undefined;

    const record = {
      eventName: rawRecord.eventName,
      new: newImage !== undefined ? decode(newImage) : undefined,
      old: oldImage !== undefined ? decode(oldImage) : undefined,
      keys: unmarshall(rawRecord.dynamodb.Keys),
      sequenceNumber: rawRecord.dynamodb?.SequenceNumber,
      timestamp: rawRecord.dynamodb?.ApproximateCreationDateTime,
    } as TableRecord<T>;

    records.push(record);
    if (rawRecord.dynamodb?.SequenceNumber) {
      sequenceNumbers.set(record, rawRecord.dynamodb.SequenceNumber);
    }
  }

  return { records, sequenceNumbers };
};

const collectFailures = (records: TableRecord<any>[], sequenceNumbers: Map<TableRecord<any>, string>): BatchItemFailure[] => {
  const failures: BatchItemFailure[] = [];
  for (const record of records) {
    const seq = sequenceNumbers.get(record);
    if (seq) failures.push({ itemIdentifier: seq });
  }
  return failures;
};

const ENV_TABLE_SELF = "EFF_TABLE_SELF";

export const wrapTableStream = <T, C, R>(handler: TableHandler<T, C, R>) => {
  if (!handler.onRecord && !handler.onBatch) {
    throw new Error("wrapTableStream requires a handler with onRecord or onBatch defined");
  }

  const rt = createHandlerRuntime(handler, "table");
  const handleError = handler.onError ?? ((e: unknown) => console.error(`[effortless:${rt.handlerName}]`, e));

  let selfClient: ReturnType<typeof createTableClient> | null = null;
  const getSelfClient = () => {
    if (selfClient) return selfClient;
    const tableName = process.env[ENV_TABLE_SELF];
    if (!tableName) return undefined;
    selfClient = createTableClient(tableName);
    return selfClient;
  };

  return async (event: DynamoDBStreamEvent) => {
    const startTime = Date.now();
    const rawRecords = event.Records ?? [];
    const input = truncateForStorage({ recordCount: rawRecords.length });

    let records: TableRecord<T>[];
    let sequenceNumbers: Map<TableRecord<T>, string>;
    try {
      ({ records, sequenceNumbers } = parseRecords<T>(rawRecords, handler.schema));
    } catch (error) {
      handleError(error);
      rt.logError(startTime, input, error);
      return { batchItemFailures: rawRecords.map(r => r.dynamodb?.SequenceNumber).filter((s): s is string => !!s).map(seq => ({ itemIdentifier: seq })) };
    }

    const shared = { ...await rt.commonArgs(), table: getSelfClient() };
    const batchItemFailures: BatchItemFailure[] = [];

    if (handler.onBatch) {
      try {
        await (handler.onBatch as any)({ records, ...shared });
      } catch (error) {
        handleError(error);
        batchItemFailures.push(...collectFailures(records, sequenceNumbers));
      }
    } else {
      // Per-record mode
      const results: R[] = [];
      const failures: FailedRecord<T>[] = [];
      const onRecord = handler.onRecord as any;

      for (const record of records) {
        try {
          const result = await onRecord({ record, ...shared });
          if (result !== undefined) results.push(result);
        } catch (error) {
          handleError(error);
          failures.push({ record, error });
          const seq = sequenceNumbers.get(record);
          if (seq) batchItemFailures.push({ itemIdentifier: seq });
        }
      }

      if (handler.onBatchComplete) {
        try {
          await (handler.onBatchComplete as any)({ results, failures, ...shared });
        } catch (error) {
          handleError(error);
          // Mark all non-failed records as failed too
          for (const record of records) {
            const seq = sequenceNumbers.get(record);
            if (seq && !batchItemFailures.some(f => f.itemIdentifier === seq)) {
              batchItemFailures.push({ itemIdentifier: seq });
            }
          }
        }
      }
    }

    if (batchItemFailures.length > 0) {
      rt.logError(startTime, input, `${batchItemFailures.length} record(s) failed`);
    } else {
      rt.logExecution(startTime, input, { processedCount: records.length });
    }

    return { batchItemFailures };
  };
};
