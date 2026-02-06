import { Effect } from "effect";
import * as dynamodb from "./clients/dynamodb";
import * as lambda from "./clients/lambda";

import { toAwsTagList } from "./tags";

// Types from define-table (duplicated to avoid circular dependency)
export type KeyType = "string" | "number" | "binary";
export type StreamView = "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" | "KEYS_ONLY";
export type BillingMode = "PAY_PER_REQUEST" | "PROVISIONED";
export type KeyDefinition = { name: string; type: KeyType };

const keyTypeToDynamoDB = (type: KeyType): "S" | "N" | "B" => {
  switch (type) {
    case "string": return "S";
    case "number": return "N";
    case "binary": return "B";
    default: return type satisfies never;
  }
};

const streamViewToSpec = (view: StreamView) => ({
  StreamEnabled: true,
  StreamViewType: view
});

export type EnsureTableInput = {
  name: string;
  pk: KeyDefinition;
  sk?: KeyDefinition;
  billingMode?: BillingMode;
  streamView?: StreamView;
  tags?: Record<string, string>;
};

export type EnsureTableResult = {
  tableArn: string;
  streamArn: string;
};

const waitForTableActive = (tableName: string) =>
  Effect.gen(function* () {
    const maxAttempts = 30;
    const delayMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = yield* dynamodb.make("describe_table", { TableName: tableName });
      const status = result.Table?.TableStatus;

      if (status === "ACTIVE") {
        return result.Table;
      }

      if (status === "CREATING" || status === "UPDATING") {
        yield* Effect.sleep(delayMs);
        continue;
      }

      return yield* Effect.fail(new Error(`Table ${tableName} is in unexpected state: ${status}`));
    }

    return yield* Effect.fail(new Error(`Timeout waiting for table ${tableName} to become active`));
  });

export const ensureTable = (input: EnsureTableInput) =>
  Effect.gen(function* () {
    const { name, pk, sk, billingMode = "PAY_PER_REQUEST", streamView = "NEW_AND_OLD_IMAGES", tags } = input;

    const existingTable = yield* dynamodb.make("describe_table", { TableName: name }).pipe(
      Effect.map(result => result.Table),
      Effect.catchIf(
        (error) => error instanceof dynamodb.DynamoDBError && error.cause.name === "ResourceNotFoundException",
        () => Effect.succeed(undefined)
      )
    );

    if (!existingTable) {
      yield* Effect.logInfo(`Creating table ${name}...`);

      const keySchema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }> = [
        { AttributeName: pk.name, KeyType: "HASH" }
      ];
      const attributeDefinitions: Array<{ AttributeName: string; AttributeType: "S" | "N" | "B" }> = [
        { AttributeName: pk.name, AttributeType: keyTypeToDynamoDB(pk.type) }
      ];

      if (sk) {
        keySchema.push({ AttributeName: sk.name, KeyType: "RANGE" });
        attributeDefinitions.push({ AttributeName: sk.name, AttributeType: keyTypeToDynamoDB(sk.type) });
      }

      yield* dynamodb.make("create_table", {
        TableName: name,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: billingMode,
        StreamSpecification: streamViewToSpec(streamView),
        Tags: tags ? toAwsTagList(tags) : undefined
      });

      const table = yield* waitForTableActive(name);
      return {
        tableArn: table!.TableArn!,
        streamArn: table!.LatestStreamArn!
      };
    }

    yield* Effect.logInfo(`Table ${name} already exists`);

    // Sync tags on existing table
    if (tags) {
      yield* dynamodb.make("tag_resource", {
        ResourceArn: existingTable.TableArn!,
        Tags: toAwsTagList(tags)
      });
    }

    if (!existingTable.StreamSpecification?.StreamEnabled) {
      yield* Effect.logInfo(`Enabling stream on table ${name}...`);
      yield* dynamodb.make("update_table", {
        TableName: name,
        StreamSpecification: streamViewToSpec(streamView)
      });
      const table = yield* waitForTableActive(name);
      return {
        tableArn: table!.TableArn!,
        streamArn: table!.LatestStreamArn!
      };
    }

    return {
      tableArn: existingTable.TableArn!,
      streamArn: existingTable.LatestStreamArn!
    };
  });

export type EnsureEventSourceMappingInput = {
  functionArn: string;
  streamArn: string;
  batchSize?: number;
  batchWindow?: number;
  startingPosition?: "LATEST" | "TRIM_HORIZON";
};

export const ensureEventSourceMapping = (input: EnsureEventSourceMappingInput) =>
  Effect.gen(function* () {
    const { functionArn, streamArn, batchSize = 100, batchWindow, startingPosition = "LATEST" } = input;

    const existingMappings = yield* lambda.make("list_event_source_mappings", {
      FunctionName: functionArn,
      EventSourceArn: streamArn
    });

    const existing = existingMappings.EventSourceMappings?.[0];

    if (existing) {
      yield* Effect.logInfo(`Updating event source mapping...`);
      yield* lambda.make("update_event_source_mapping", {
        UUID: existing.UUID!,
        FunctionName: functionArn,
        BatchSize: batchSize,
        ...(batchWindow !== undefined ? { MaximumBatchingWindowInSeconds: batchWindow } : {}),
        Enabled: true
      });
      return existing.UUID!;
    }

    yield* Effect.logInfo(`Creating event source mapping...`);
    const result = yield* lambda.make("create_event_source_mapping", {
      FunctionName: functionArn,
      EventSourceArn: streamArn,
      BatchSize: batchSize,
      ...(batchWindow !== undefined ? { MaximumBatchingWindowInSeconds: batchWindow } : {}),
      StartingPosition: startingPosition,
      Enabled: true
    });

    return result.UUID!;
  });

export const deleteTable = (tableName: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Deleting DynamoDB table: ${tableName}`);

    yield* dynamodb.make("delete_table", {
      TableName: tableName
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof dynamodb.DynamoDBError && error.cause.name === "ResourceNotFoundException",
        () => Effect.logDebug(`Table ${tableName} not found, skipping`)
      )
    );
  });
