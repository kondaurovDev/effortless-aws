import { Effect, Schedule } from "effect";
import { dynamodb, lambda } from "./clients";

import { toAwsTagList } from "./tags";

// Types from define-table (duplicated to avoid circular dependency)
export type StreamView = "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES" | "KEYS_ONLY";
export type BillingMode = "PAY_PER_REQUEST" | "PROVISIONED";

/** Built-in GSI: tag (PK) + pk (SK) — enables cross-partition queries by entity type */
export const GSI_TAG_PK = "tag-pk-index";

const streamViewToSpec = (view: StreamView) => ({
  StreamEnabled: true,
  StreamViewType: view
});

export type EnsureTableInput = {
  name: string;
  billingMode?: BillingMode;
  streamView?: StreamView;
  tags?: Record<string, string>;
};

export type EnsureTableResult = {
  tableArn: string;
  streamArn: string;
};

const waitForTableActive = (tableName: string) =>
  Effect.retry(
    dynamodb.make("describe_table", { TableName: tableName }).pipe(
      Effect.flatMap(r => {
        const status = r.Table?.TableStatus;
        if (status === "ACTIVE") return Effect.succeed(r.Table!);
        if (status === "CREATING" || status === "UPDATING") {
          return Effect.fail(new Error(`Table ${tableName} status: ${status}`));
        }
        return Effect.die(new Error(`Table ${tableName} is in unexpected state: ${status}`));
      })
    ),
    {
      times: 15,
      schedule: Schedule.spaced("2 seconds"),
    }
  );

const ensureTimeToLive = (tableName: string, attributeName: string) =>
  Effect.gen(function* () {
    const current = yield* dynamodb.make("describe_time_to_live", {
      TableName: tableName,
    });

    const status = current.TimeToLiveDescription?.TimeToLiveStatus;
    const currentAttr = current.TimeToLiveDescription?.AttributeName;

    if (status === "ENABLED" && currentAttr === attributeName) {
      return;
    }

    if (status === "ENABLING") {
      yield* Effect.logInfo(`TTL is being enabled on ${tableName}, waiting...`);
      yield* Effect.sleep(5000);
      return;
    }

    yield* Effect.logInfo(`Enabling TTL on ${tableName} (attribute: ${attributeName})`);
    yield* dynamodb.make("update_time_to_live", {
      TableName: tableName,
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: attributeName,
      },
    });
  });

export const ensureTable = (input: EnsureTableInput) =>
  Effect.gen(function* () {
    const { name, billingMode = "PAY_PER_REQUEST", streamView = "NEW_AND_OLD_IMAGES", tags } = input;

    const existingTable = yield* dynamodb.make("describe_table", { TableName: name }).pipe(
      Effect.map(result => result.Table),
      Effect.catchIf(
        (error) => error instanceof dynamodb.DynamoDBError && error.cause.name === "ResourceNotFoundException",
        () => Effect.succeed(undefined)
      )
    );

    let result: EnsureTableResult;

    if (!existingTable) {
      yield* Effect.logInfo(`Creating table ${name}...`);

      yield* dynamodb.make("create_table", {
        TableName: name,
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "tag", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [{
          IndexName: GSI_TAG_PK,
          KeySchema: [
            { AttributeName: "tag", KeyType: "HASH" },
            { AttributeName: "pk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }],
        BillingMode: billingMode,
        StreamSpecification: streamViewToSpec(streamView),
        Tags: tags ? toAwsTagList(tags) : undefined
      });

      const table = yield* waitForTableActive(name);
      result = {
        tableArn: table!.TableArn!,
        streamArn: table!.LatestStreamArn!
      };
    } else {
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
        yield* waitForTableActive(name);
      }

      // Ensure GSI exists on existing table
      const hasGsi = existingTable.GlobalSecondaryIndexes?.some(
        gsi => gsi.IndexName === GSI_TAG_PK
      );
      if (!hasGsi) {
        yield* Effect.logInfo(`Adding GSI ${GSI_TAG_PK} to table ${name}...`);
        yield* dynamodb.make("update_table", {
          TableName: name,
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "tag", AttributeType: "S" },
          ],
          GlobalSecondaryIndexUpdates: [{
            Create: {
              IndexName: GSI_TAG_PK,
              KeySchema: [
                { AttributeName: "tag", KeyType: "HASH" },
                { AttributeName: "pk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            }
          }],
        });
        yield* waitForTableActive(name);
      }

      // Re-describe to get latest ARNs after potential updates
      const updated = yield* dynamodb.make("describe_table", { TableName: name });
      result = {
        tableArn: updated.Table!.TableArn!,
        streamArn: updated.Table!.LatestStreamArn!
      };
    }

    // Always enable TTL on the "ttl" attribute (zero-cost when unused)
    yield* ensureTimeToLive(name, "ttl");

    return result;
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
