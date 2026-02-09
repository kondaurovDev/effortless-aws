import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { TableHandler, TableRecord, FailedRecord } from "~/handlers/define-table";
import { createTableClient } from "./table-client";
import { buildDeps, buildParams } from "./handler-utils";

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

const ENV_TABLE_SELF = "EFF_TABLE_SELF";

export const wrapTableStream = <T, C, R>(handler: TableHandler<T, C, R>) => {
  if (!handler.onRecord && !handler.onBatch) {
    throw new Error("wrapTableStream requires a handler with onRecord or onBatch defined");
  }

  const handleError = handler.onError ?? ((e: unknown) => console.error(e));

  let ctx: C | null = null;
  let resolvedDeps: Record<string, unknown> | undefined;
  let resolvedParams: Record<string, unknown> | undefined | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDeps = () => (resolvedDeps ??= buildDeps((handler as any).deps));

  const getParams = async () => {
    if (resolvedParams !== null) return resolvedParams;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolvedParams = await buildParams((handler as any).params);
    return resolvedParams;
  };

  const getCtx = async () => {
    if (ctx !== null) return ctx;
    if (handler.context) {
      const params = await getParams();
      ctx = params
        ? await handler.context({ params })
        : await handler.context();
    }
    return ctx;
  };

  let selfClient: ReturnType<typeof createTableClient> | null = null;
  const getSelfClient = () => {
    if (selfClient) return selfClient;
    const tableName = process.env[ENV_TABLE_SELF];
    if (!tableName) return undefined;
    selfClient = createTableClient(tableName);
    return selfClient;
  };

  /** Build common args (ctx + deps + params + table) to merge into each callback invocation */
  const commonArgs = async (): Promise<Record<string, unknown>> => {
    const args: Record<string, unknown> = {};
    if (handler.context) args.ctx = await getCtx();
    const deps = getDeps();
    if (deps) args.deps = deps;
    const params = await getParams();
    if (params) args.params = params;
    const table = getSelfClient();
    if (table) args.table = table;
    return args;
  };

  return async (event: DynamoDBStreamEvent) => {
    const rawRecords = event.Records ?? [];
    let records: TableRecord<T>[];
    let sequenceNumbers: Map<TableRecord<T>, string>;
    try {
      ({ records, sequenceNumbers } = parseRecords<T>(rawRecords, handler.schema));
    } catch (error) {
      handleError(error);
      return {
        batchItemFailures: rawRecords
          .map(r => r.dynamodb?.SequenceNumber)
          .filter((s): s is string => !!s)
          .map(seq => ({ itemIdentifier: seq }))
      };
    }
    const batchItemFailures: BatchItemFailure[] = [];

    if (handler.onBatch) {
      // Batch mode: pass all records at once
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onBatch = handler.onBatch as any;
        await onBatch({ records, ...await commonArgs() });
      } catch (error) {
        handleError(error);
        for (const record of records) {
          const seq = sequenceNumbers.get(record);
          if (seq) {
            batchItemFailures.push({ itemIdentifier: seq });
          }
        }
      }

      return { batchItemFailures };
    }

    // Per-record mode
    const results: R[] = [];
    const failures: FailedRecord<T>[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRecord = handler.onRecord as any;
    const shared = await commonArgs();

    for (const record of records) {
      try {
        const result = await onRecord({ record, ...shared });

        if (result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        handleError(error);
        failures.push({ record, error });
        const seq = sequenceNumbers.get(record);
        if (seq) {
          batchItemFailures.push({ itemIdentifier: seq });
        }
      }
    }

    if (handler.onBatchComplete) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onBatchComplete = handler.onBatchComplete as any;
        await onBatchComplete({ results, failures, ...shared });
      } catch (error) {
        handleError(error);
        for (const record of records) {
          const seq = sequenceNumbers.get(record);
          if (seq) {
            const alreadyFailed = batchItemFailures.some((f) => f.itemIdentifier === seq);
            if (!alreadyFailed) {
              batchItemFailures.push({ itemIdentifier: seq });
            }
          }
        }
      }
    }

    return { batchItemFailures };
  };
};
