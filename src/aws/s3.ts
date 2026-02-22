import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { s3, lambda } from "./clients";
import { toAwsTagList } from "./tags";

// Reuse the same content-type map as wrap-app.ts
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".gz": "application/gzip",
  ".zip": "application/zip",
};

export type EnsureBucketInput = {
  name: string;
  region: string;
  tags: Record<string, string>;
};

export const ensureBucket = (input: EnsureBucketInput) =>
  Effect.gen(function* () {
    const { name, region, tags } = input;

    // Check if bucket exists
    const exists = yield* s3.make("head_bucket", { Bucket: name }).pipe(
      Effect.map(() => true),
      Effect.catchIf(
        e => e._tag === "S3Error",
        () => Effect.succeed(false)
      )
    );

    if (!exists) {
      yield* Effect.logDebug(`Creating S3 bucket: ${name}`);
      yield* s3.make("create_bucket", {
        Bucket: name,
        ...(region !== "us-east-1"
          ? { CreateBucketConfiguration: { LocationConstraint: region as any } }
          : {}),
      });
    } else {
      yield* Effect.logDebug(`S3 bucket ${name} already exists`);
    }

    // Block all public access
    yield* s3.make("put_public_access_block", {
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });

    // Apply tags
    yield* s3.make("put_bucket_tagging", {
      Bucket: name,
      Tagging: { TagSet: toAwsTagList(tags) },
    });

    return { bucketName: name, bucketArn: `arn:aws:s3:::${name}` };
  });

export type SyncFilesInput = {
  bucketName: string;
  sourceDir: string;
};

export type SyncFilesResult = {
  uploaded: number;
  deleted: number;
  unchanged: number;
};

export const syncFiles = (input: SyncFilesInput) =>
  Effect.gen(function* () {
    const { bucketName, sourceDir } = input;

    // List existing objects in bucket
    const existingObjects = new Map<string, string>(); // key -> ETag
    let continuationToken: string | undefined;

    do {
      const result = yield* s3.make("list_objects_v2", {
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      });
      for (const obj of result.Contents ?? []) {
        if (obj.Key && obj.ETag) {
          existingObjects.set(obj.Key, obj.ETag);
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    // Walk local directory
    const localFiles = new Map<string, string>(); // key -> absolute path
    const walkDir = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, key);
        } else {
          localFiles.set(key, fullPath);
        }
      }
    };
    walkDir(sourceDir, "");

    let uploaded = 0;
    let unchanged = 0;

    // Upload new/changed files
    for (const [key, filePath] of localFiles) {
      const content = fs.readFileSync(filePath);
      const md5 = crypto.createHash("md5").update(content).digest("hex");
      const etag = `"${md5}"`;

      if (existingObjects.get(key) === etag) {
        unchanged++;
        continue;
      }

      const ext = path.extname(key).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      const isHtml = ext === ".html" || ext === ".htm";
      const cacheControl = isHtml
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable";

      yield* s3.make("put_object", {
        Bucket: bucketName,
        Key: key,
        Body: content,
        ContentType: contentType,
        CacheControl: cacheControl,
      });
      uploaded++;
    }

    // Delete files that no longer exist locally
    const keysToDelete = [...existingObjects.keys()].filter(k => !localFiles.has(k));
    let deleted = 0;

    if (keysToDelete.length > 0) {
      // Batch delete, up to 1000 at a time
      for (let i = 0; i < keysToDelete.length; i += 1000) {
        const batch = keysToDelete.slice(i, i + 1000);
        yield* s3.make("delete_objects", {
          Bucket: bucketName,
          Delete: {
            Objects: batch.map(Key => ({ Key })),
            Quiet: true,
          },
        });
        deleted += batch.length;
      }
    }

    yield* Effect.logDebug(`S3 sync: ${uploaded} uploaded, ${deleted} deleted, ${unchanged} unchanged`);
    return { uploaded, deleted, unchanged } satisfies SyncFilesResult;
  });

export const putBucketPolicyForOAC = (bucketName: string, distributionArn: string) =>
  Effect.gen(function* () {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowCloudFrontServicePrincipalReadOnly",
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucketName}/*`,
          Condition: {
            StringEquals: {
              "AWS:SourceArn": distributionArn,
            },
          },
        },
      ],
    });

    yield* s3.make("put_bucket_policy", {
      Bucket: bucketName,
      Policy: policy,
    });
  });

export const emptyBucket = (bucketName: string) =>
  Effect.gen(function* () {
    let continuationToken: string | undefined;

    do {
      const result = yield* s3.make("list_objects_v2", {
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      });

      const objects = result.Contents ?? [];
      if (objects.length > 0) {
        yield* s3.make("delete_objects", {
          Bucket: bucketName,
          Delete: {
            Objects: objects.map(o => ({ Key: o.Key! })),
            Quiet: true,
          },
        });
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
  });

export const deleteBucket = (bucketName: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting S3 bucket: ${bucketName}`);

    yield* emptyBucket(bucketName).pipe(
      Effect.catchIf(
        e => e._tag === "S3Error" && e.is("NoSuchBucket"),
        () => Effect.logDebug(`Bucket ${bucketName} not found, skipping`)
      )
    );

    yield* s3.make("delete_bucket", { Bucket: bucketName }).pipe(
      Effect.catchIf(
        e => e._tag === "S3Error" && e.is("NoSuchBucket"),
        () => Effect.logDebug(`Bucket ${bucketName} not found, skipping`)
      )
    );
  });

// ============ Bucket event notifications ============

export type EnsureBucketNotificationInput = {
  bucketName: string;
  functionArn: string;
  events: string[];
  prefix?: string;
  suffix?: string;
};

export const ensureBucketNotification = (input: EnsureBucketNotificationInput) =>
  Effect.gen(function* () {
    const { bucketName, functionArn, events, prefix, suffix } = input;

    const filterRules: { Name: "prefix" | "suffix"; Value: string }[] = [];
    if (prefix) filterRules.push({ Name: "prefix", Value: prefix });
    if (suffix) filterRules.push({ Name: "suffix", Value: suffix });

    yield* s3.make("put_bucket_notification_configuration", {
      Bucket: bucketName,
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          {
            LambdaFunctionArn: functionArn,
            Events: events as any[],
            ...(filterRules.length > 0 ? {
              Filter: {
                Key: { FilterRules: filterRules },
              },
            } : {}),
          },
        ],
      },
    });

    yield* Effect.logDebug(`S3 bucket notification configured for ${bucketName}`);
  });

export const addS3LambdaPermission = (
  functionArn: string,
  bucketName: string,
) =>
  Effect.gen(function* () {
    const accountId = functionArn.split(":")[4];
    const bucketArn = `arn:aws:s3:::${bucketName}`;
    const statementId = `s3-${bucketName}`;

    yield* lambda.make("add_permission", {
      FunctionName: functionArn,
      StatementId: statementId,
      Action: "lambda:InvokeFunction",
      Principal: "s3.amazonaws.com",
      SourceArn: bucketArn,
      SourceAccount: accountId,
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceConflictException"),
        () => Effect.logDebug("S3 Lambda permission already exists"),
      )
    );
  });
