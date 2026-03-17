import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { TableHandler, TableRecord } from "../handlers/define-table";
import type { TableItem } from "../handlers/handler-options";
import { createTableClient } from "./table-client";
import { createHandlerRuntime } from "./handler-utils";

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

const toTableItem = <T>(raw: Record<string, unknown>, decode: (input: unknown) => T): TableItem<T> => ({
  pk: raw.pk as string,
  sk: raw.sk as string,
  tag: raw.tag as string,
  data: decode(raw.data),
  ...(raw.ttl !== undefined ? { ttl: raw.ttl as number } : {}),
});

const parseRecords = <T>(rawRecords: DynamoDBStreamRecord[], schema?: (input: unknown) => T): { records: TableRecord<T>[]; sequenceNumbers: Map<TableRecord<T>, string> } => {
  const records: TableRecord<T>[] = [];
  const sequenceNumbers = new Map<TableRecord<T>, string>();
  const decode = schema ?? ((x: unknown) => x as T);

  for (const rawRecord of rawRecords) {
    if (!rawRecord.dynamodb?.Keys) continue;

    const newImage = rawRecord.dynamodb?.NewImage ? unmarshall(rawRecord.dynamodb.NewImage) : undefined;
    const oldImage = rawRecord.dynamodb?.OldImage ? unmarshall(rawRecord.dynamodb.OldImage) : undefined;
    const keys = unmarshall(rawRecord.dynamodb.Keys) as { pk: string; sk: string };

    const record = {
      eventName: rawRecord.eventName,
      new: newImage !== undefined ? toTableItem(newImage, decode) : undefined,
      old: oldImage !== undefined ? toTableItem(oldImage, decode) : undefined,
      keys,
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

const ENV_DEP_SELF = "EFF_DEP_SELF";

export const wrapTableStream = <T, C>(handler: TableHandler<T, C>) => {
  if (!handler.onRecord && !handler.onRecordBatch) {
    throw new Error("wrapTableStream requires a handler with onRecord or onRecordBatch defined");
  }

  const tagField = handler.__spec.tagField ?? "tag";
  const concurrency = handler.__spec.concurrency ?? 1;

  let selfClient: ReturnType<typeof createTableClient> | null = null;
  const getSelfClient = () => {
    if (selfClient) return selfClient;
    const raw = process.env[ENV_DEP_SELF];
    if (!raw) return undefined;
    const tableName = raw.startsWith("table:") ? raw.slice(6) : raw;
    selfClient = createTableClient(tableName, { tagField });
    return selfClient;
  };

  const rt = createHandlerRuntime(handler, "table", handler.__spec.lambda?.logLevel ?? "info", () => {
    const table = getSelfClient();
    return table ? { table } : {};
  });
  const handleError = handler.onError ?? (({ error }: { error: unknown }) => console.error(`[effortless:${rt.handlerName}]`, error));

  return async (event: DynamoDBStreamEvent) => {
    const startTime = Date.now();
    rt.patchConsole();
    let ctxProps: Record<string, unknown> = {};

    try {
      const rawRecords = event.Records ?? [];
      const input = { recordCount: rawRecords.length };

      const common = await rt.commonArgs();
      const ctx = common.ctx;
      ctxProps = ctx && typeof ctx === "object" ? { ...ctx as Record<string, unknown> } : {};
      const shared = { ...ctxProps };

      let records: TableRecord<T>[];
      let sequenceNumbers: Map<TableRecord<T>, string>;
      try {
        ({ records, sequenceNumbers } = parseRecords<T>(rawRecords, handler.schema));
      } catch (error) {
        handleError({ error, ...shared });
        rt.logError(startTime, input, error);
        return { batchItemFailures: rawRecords.map(r => r.dynamodb?.SequenceNumber).filter((s): s is string => !!s).map(seq => ({ itemIdentifier: seq })) };
      }

      const batchItemFailures: BatchItemFailure[] = [];
      const frozenBatch = Object.freeze(records);

      if (handler.onRecordBatch) {
        try {
          const result = await (handler.onRecordBatch as any)({ records: frozenBatch, ...shared });
          if (result?.failures) {
            for (const seq of result.failures) {
              batchItemFailures.push({ itemIdentifier: seq });
            }
          }
        } catch (error) {
          handleError({ error, ...shared });
          for (const record of records) {
            const seq = sequenceNumbers.get(record);
            if (seq) batchItemFailures.push({ itemIdentifier: seq });
          }
        }
      } else {
        const onRecord = handler.onRecord as any;
        if (concurrency <= 1) {
          for (const record of records) {
            try {
              await onRecord({ record, batch: frozenBatch, ...shared });
            } catch (error) {
              handleError({ error, ...shared });
              const seq = sequenceNumbers.get(record);
              if (seq) batchItemFailures.push({ itemIdentifier: seq });
            }
          }
        } else {
          for (let i = 0; i < records.length; i += concurrency) {
            const chunk = records.slice(i, i + concurrency);
            const results = await Promise.allSettled(
              chunk.map(record => onRecord({ record, batch: frozenBatch, ...shared }))
            );
            for (let j = 0; j < results.length; j++) {
              const result = results[j]!;
              const record = chunk[j]!;
              if (result.status === "rejected") {
                handleError({ error: (result as PromiseRejectedResult).reason, ...shared });
                const seq = sequenceNumbers.get(record);
                if (seq) batchItemFailures.push({ itemIdentifier: seq });
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
    } finally {
      if (handler.onAfterInvoke) {
        try { await handler.onAfterInvoke(ctxProps); }
        catch (e) { console.error(`[effortless:${rt.handlerName}] onAfterInvoke error`, e); }
      }
      rt.restoreConsole();
    }
  };
};
