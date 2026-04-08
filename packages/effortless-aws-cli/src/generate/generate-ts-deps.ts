/**
 * Shared code generation for dependency client types and factories.
 * Used by all handler-type generators to produce the deps section of handler.gen.ts.
 */

export type GenerateDepsInput = {
  /** Dep names and their handler types (e.g., { db: "table", uploads: "bucket" }) */
  deps: Record<string, string>;
};

type DepsSection = {
  /** Type definitions for clients + Deps type */
  types: string;
  /** Runtime code: client factories + resolveDeps function */
  runtime: string;
};

const CLIENT_TYPES: Record<string, string> = {
  table: `type TableClient = {
  get(pk: string, sk: string): Promise<Record<string, unknown> | null>;
  put(pk: string, sk: string, data: Record<string, unknown>): Promise<void>;
  query(params: { pk: string; sk?: string; limit?: number }): Promise<Record<string, unknown>[]>;
  delete(pk: string, sk: string): Promise<void>;
};`,
  bucket: `type BucketClient = {
  get(key: string): Promise<string | null>;
  put(key: string, body: string | Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
};`,
  fifoQueue: `type QueueClient = {
  send(body: unknown, groupId?: string, deduplicationId?: string): Promise<void>;
};`,
  mailer: `type EmailClient = {
  send(options: { to: string | string[]; subject: string; html?: string; text?: string; from?: string }): Promise<void>;
};`,
  worker: `type WorkerClient = {
  send(message: unknown): Promise<void>;
};`,
};

const DEP_TYPE_TO_CLIENT: Record<string, string> = {
  table: "TableClient",
  bucket: "BucketClient",
  fifoQueue: "QueueClient",
  mailer: "EmailClient",
  worker: "WorkerClient",
};

const CLIENT_FACTORIES: Record<string, string> = {
  table: `
function createTableClient(tableName: string): TableClient {
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    async get(pk, sk) {
      const res = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
      return (res.Item as Record<string, unknown>) ?? null;
    },
    async put(pk, sk, data) {
      await client.send(new PutCommand({ TableName: tableName, Item: { pk, sk, data } }));
    },
    async query(params) {
      const res = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: params.sk ? "pk = :pk AND sk = :sk" : "pk = :pk",
        ExpressionAttributeValues: { ":pk": params.pk, ...(params.sk ? { ":sk": params.sk } : {}) },
        ...(params.limit ? { Limit: params.limit } : {}),
      }));
      return (res.Items as Record<string, unknown>[]) ?? [];
    },
    async delete(pk, sk) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }));
    },
  };
}`,
  bucket: `
function createBucketClient(bucketName: string): BucketClient {
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({});
  return {
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
        return await res.Body?.transformToString() ?? null;
      } catch { return null; }
    },
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body }));
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
    },
    async getSignedUrl(key, expiresIn = 3600) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn });
    },
  };
}`,
  fifoQueue: `
function createQueueClient(queueUrl: string): QueueClient {
  const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
  const sqs = new SQSClient({});
  return {
    async send(body, groupId, deduplicationId) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        ...(groupId ? { MessageGroupId: groupId } : {}),
        ...(deduplicationId ? { MessageDeduplicationId: deduplicationId } : {}),
      }));
    },
  };
}`,
  mailer: `
function createEmailClient(): EmailClient {
  const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
  const ses = new SESv2Client({});
  return {
    async send(options) {
      const to = Array.isArray(options.to) ? options.to : [options.to];
      await ses.send(new SendEmailCommand({
        Destination: { ToAddresses: to },
        Content: {
          Simple: {
            Subject: { Data: options.subject },
            Body: {
              ...(options.html ? { Html: { Data: options.html } } : {}),
              ...(options.text ? { Text: { Data: options.text } } : {}),
            },
          },
        },
        ...(options.from ? { FromEmailAddress: options.from } : {}),
      }));
    },
  };
}`,
  worker: `
function createWorkerClient(queueUrl: string): WorkerClient {
  const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
  const sqs = new SQSClient({});
  return {
    async send(message) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      }));
    },
  };
}`,
};

const DEP_RESOLVE_EXPR: Record<string, (name: string) => string> = {
  table: (name) => `createTableClient(getEnvDep("${name}"))`,
  bucket: (name) => `createBucketClient(getEnvDep("${name}"))`,
  fifoQueue: (name) => `createQueueClient(getEnvDep("${name}"))`,
  mailer: (_name) => `createEmailClient()`,
  worker: (name) => `createWorkerClient(getEnvDep("${name}"))`,
};

export const generateDepsSection = (deps: Record<string, string>): DepsSection => {
  const hasDeps = Object.keys(deps).length > 0;
  if (!hasDeps) return { types: "", runtime: "" };

  // Collect unique dep types needed
  const neededTypes = new Set(Object.values(deps));

  // Types section
  const typeLines: string[] = ["// --- Dep clients ---\n"];
  for (const depType of neededTypes) {
    const clientType = CLIENT_TYPES[depType];
    if (clientType) typeLines.push(clientType + "\n");
  }

  const depsTypeEntries = Object.entries(deps).map(([name, type]) => {
    const clientName = DEP_TYPE_TO_CLIENT[type] ?? "unknown";
    return `  ${name}: ${clientName};`;
  });
  typeLines.push(`export type Deps = {\n${depsTypeEntries.join("\n")}\n};\n`);

  // Runtime section
  const runtimeLines: string[] = [];
  for (const depType of neededTypes) {
    const factory = CLIENT_FACTORIES[depType];
    if (factory) runtimeLines.push(factory);
  }

  const depEntries = Object.entries(deps).map(([name, type]) => {
    const expr = DEP_RESOLVE_EXPR[type];
    return `    ${name}: ${expr ? expr(name) : "undefined as any"},`;
  });

  runtimeLines.push(`
function getEnvDep(name: string): string {
  const raw = process.env[\`EFF_DEP_\${name}\`];
  if (!raw) throw new Error(\`Missing dependency env var: EFF_DEP_\${name}\`);
  const colonIdx = raw.indexOf(":");
  return colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
}

function resolveDeps(): Deps {
  return {
${depEntries.join("\n")}
  };
}
`);

  return {
    types: typeLines.join("\n"),
    runtime: runtimeLines.join("\n"),
  };
};
