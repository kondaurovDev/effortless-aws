import { S3 } from "@aws-sdk/client-s3";

/**
 * S3 bucket client for runtime operations.
 * Provides basic CRUD: put, get, delete, list.
 */
export type BucketClient = {
  /** Upload an object to the bucket */
  put(key: string, body: Buffer | string, options?: { contentType?: string }): Promise<void>;
  /** Get an object from the bucket. Returns undefined if key does not exist. */
  get(key: string): Promise<{ body: Buffer; contentType?: string } | undefined>;
  /** Delete an object from the bucket */
  delete(key: string): Promise<void>;
  /** List objects in the bucket, optionally filtered by prefix */
  list(prefix?: string): Promise<{ key: string; size: number; lastModified?: Date }[]>;
  /** The underlying S3 bucket name */
  bucketName: string;
};

/**
 * Typed client for a single entity stored as JSON in a bucket.
 * Objects are stored at `{entityName}/{id}.json`.
 */
export type StoreEntityClient<T> = {
  /** Store a JSON document by id */
  put(id: string, data: T): Promise<void>;
  /** Retrieve a JSON document by id. Returns undefined if not found. */
  get(id: string): Promise<T | undefined>;
  /** Delete a document by id */
  delete(id: string): Promise<void>;
  /** List all documents for this entity */
  list(): Promise<{ id: string; data: T }[]>;
};

/**
 * BucketClient extended with typed entity clients.
 */
export type BucketClientWithEntities<Entities extends Record<string, any>> =
  BucketClient & { [K in keyof Entities]: StoreEntityClient<Entities[K]> };

// ============ Internal helpers ============

const createBucketMethods = (getClient: () => S3, bucketName: string): BucketClient => ({
  bucketName,

  async put(key: string, body: Buffer | string, options?: { contentType?: string }) {
    await getClient().putObject({
      Bucket: bucketName,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
    });
  },

  async get(key: string) {
    try {
      const result = await getClient().getObject({
        Bucket: bucketName,
        Key: key,
      });
      const chunks: Buffer[] = [];
      const stream = result.Body as NodeJS.ReadableStream;
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
      }
      return {
        body: Buffer.concat(chunks),
        contentType: result.ContentType,
      };
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "NoSuchKey" || (error as any).$metadata?.httpStatusCode === 404)
      ) {
        return undefined;
      }
      throw error;
    }
  },

  async delete(key: string) {
    await getClient().deleteObject({
      Bucket: bucketName,
      Key: key,
    });
  },

  async list(prefix?: string) {
    const items: { key: string; size: number; lastModified?: Date }[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await getClient().listObjectsV2({
        Bucket: bucketName,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      });
      for (const obj of result.Contents ?? []) {
        if (obj.Key) {
          items.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified,
          });
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return items;
  },
});

const createEntityClient = (
  getClient: () => S3,
  bucketName: string,
  entityName: string,
  cacheSeconds?: number,
): StoreEntityClient<any> => {
  const entityKey = (id: string) => `${entityName}/${id}.json`;

  return {
    async put(id, data) {
      await getClient().putObject({
        Bucket: bucketName,
        Key: entityKey(id),
        Body: JSON.stringify(data),
        ContentType: "application/json",
        ...(cacheSeconds != null ? { CacheControl: `public, max-age=${cacheSeconds}` } : {}),
      });
    },

    async get(id) {
      try {
        const result = await getClient().getObject({
          Bucket: bucketName,
          Key: entityKey(id),
        });
        const chunks: Buffer[] = [];
        const stream = result.Body as NodeJS.ReadableStream;
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.name === "NoSuchKey" || (error as any).$metadata?.httpStatusCode === 404)
        ) {
          return undefined;
        }
        throw error;
      }
    },

    async delete(id) {
      await getClient().deleteObject({
        Bucket: bucketName,
        Key: entityKey(id),
      });
    },

    async list() {
      const items: { id: string; data: any }[] = [];
      let continuationToken: string | undefined;
      const prefix = `${entityName}/`;

      do {
        const result = await getClient().listObjectsV2({
          Bucket: bucketName,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        });

        for (const obj of result.Contents ?? []) {
          if (!obj.Key || !obj.Key.endsWith(".json")) continue;
          const id = obj.Key.slice(prefix.length, -".json".length);
          try {
            const getResult = await getClient().getObject({
              Bucket: bucketName,
              Key: obj.Key,
            });
            const chunks: Buffer[] = [];
            const stream = getResult.Body as NodeJS.ReadableStream;
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
            }
            items.push({ id, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
          } catch {
            // skip objects that fail to read/parse
          }
        }

        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (continuationToken);

      return items;
    },
  };
};

// ============ Public factories ============

/**
 * Creates an S3 BucketClient.
 * Lazily initializes the S3 SDK client on first use (cold start friendly).
 */
export const createBucketClient = (bucketName: string): BucketClient => {
  let client: S3 | null = null;
  const getClient = () => (client ??= new S3({}));
  return createBucketMethods(getClient, bucketName);
};

/**
 * Creates an S3 BucketClient with typed entity clients.
 * Shares a single S3 SDK instance across raw and entity operations.
 */
export const createBucketClientWithEntities = (
  bucketName: string,
  entitiesConfig: Record<string, { cacheSeconds?: number }>,
): BucketClient & Record<string, StoreEntityClient<any>> => {
  let client: S3 | null = null;
  const getClient = () => (client ??= new S3({}));

  const base = createBucketMethods(getClient, bucketName);
  const result: any = { ...base };
  for (const [entityName, config] of Object.entries(entitiesConfig)) {
    result[entityName] = createEntityClient(getClient, bucketName, entityName, config.cacheSeconds);
  }
  return result;
};
