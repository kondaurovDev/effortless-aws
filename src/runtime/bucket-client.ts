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
 * Creates an S3 BucketClient.
 * Lazily initializes the S3 SDK client on first use (cold start friendly).
 */
export const createBucketClient = (bucketName: string): BucketClient => {
  let client: S3 | null = null;
  const getClient = () => (client ??= new S3({}));

  return {
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
  };
};
