import type { BucketHandler, BucketEvent } from "~/handlers/define-bucket";
import { createBucketClient } from "./bucket-client";
import { createHandlerRuntime } from "./handler-utils";

type S3EventRecord = {
  eventName: string;
  eventTime?: string;
  s3: {
    bucket: { name: string };
    object: {
      key: string;
      size?: number;
      eTag?: string;
    };
  };
};

type S3Event = {
  Records?: S3EventRecord[];
};

const ENV_DEP_SELF = "EFF_DEP_SELF";

export const wrapBucket = <C>(handler: BucketHandler<C>) => {
  if (!handler.onObjectCreated && !handler.onObjectRemoved) {
    throw new Error("wrapBucket requires a handler with onObjectCreated or onObjectRemoved defined");
  }

  let selfClient: ReturnType<typeof createBucketClient> | null = null;
  const getSelfClient = () => {
    if (selfClient) return selfClient;
    const raw = process.env[ENV_DEP_SELF];
    if (!raw) return undefined;
    const bucketName = raw.startsWith("bucket:") ? raw.slice(7) : raw;
    selfClient = createBucketClient(bucketName);
    return selfClient;
  };

  const rt = createHandlerRuntime(handler, "bucket", handler.__spec.logLevel ?? "info", () => {
    const bucket = getSelfClient();
    return bucket ? { bucket } : {};
  });
  const handleError = handler.onError ?? ((e: unknown) => console.error(`[effortless:${rt.handlerName}]`, e));

  // S3 event notifications are fire-and-forget — no partial batch failure support,
  // so unlike table/queue wrappers we don't return batchItemFailures.
  return async (event: S3Event) => {
    const startTime = Date.now();
    rt.patchConsole();

    try {
      const rawRecords = event.Records ?? [];
      const input = { recordCount: rawRecords.length };

      const shared = { ...await rt.commonArgs(), bucket: getSelfClient() };
      let errorCount = 0;

      for (const record of rawRecords) {
        const bucketEvent: BucketEvent = {
          eventName: record.eventName,
          key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
          size: record.s3.object.size,
          eTag: record.s3.object.eTag,
          eventTime: record.eventTime,
          bucketName: record.s3.bucket.name,
        };

        try {
          if (record.eventName.startsWith("ObjectCreated:") && handler.onObjectCreated) {
            await (handler.onObjectCreated as any)({ event: bucketEvent, ...shared });
          } else if (record.eventName.startsWith("ObjectRemoved:") && handler.onObjectRemoved) {
            await (handler.onObjectRemoved as any)({ event: bucketEvent, ...shared });
          }
        } catch (error) {
          handleError(error);
          errorCount++;
        }
      }

      if (errorCount > 0) {
        rt.logError(startTime, input, `${errorCount} event(s) failed`);
      } else {
        rt.logExecution(startTime, input, { processedCount: rawRecords.length });
      }
    } finally {
      rt.restoreConsole();
    }
  };
};
