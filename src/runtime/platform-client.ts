import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  PlatformEntity,
  ExecutionEntry,
  ErrorEntry,
} from "./platform-types";
import {
  ENV_PLATFORM_TABLE,
  dateBucket,
  computeTtl,
} from "./platform-types";

export type PlatformClient = {
  appendExecution(handlerName: string, handlerType: "http" | "table", entry: ExecutionEntry): Promise<void>;
  appendError(handlerName: string, handlerType: "http" | "table", entry: ErrorEntry): Promise<void>;
  get<T extends PlatformEntity>(pk: string, sk: string): Promise<T | undefined>;
  query<T extends PlatformEntity>(pk: string, skPrefix?: string): Promise<T[]>;
  put(entity: PlatformEntity): Promise<void>;
  tableName: string;
};

export const createPlatformClient = (): PlatformClient | undefined => {
  const tableName = process.env[ENV_PLATFORM_TABLE];
  if (!tableName) return undefined;

  let client: DynamoDB | null = null;
  const getClient = () => (client ??= new DynamoDB({}));

  const appendToList = async (
    handlerName: string,
    handlerType: "http" | "table",
    listAttr: "executions" | "errors",
    entry: ExecutionEntry | ErrorEntry
  ): Promise<void> => {
    const sk = `EXEC#${dateBucket()}`;

    try {
      await getClient().updateItem({
        TableName: tableName,
        Key: marshall({ pk: `HANDLER#${handlerName}`, sk }),
        UpdateExpression:
          "SET #list = list_append(if_not_exists(#list, :empty), :entry), " +
          "#type = :type, #hn = :hn, #ht = :ht, #ttl = :ttl",
        ExpressionAttributeNames: {
          "#list": listAttr,
          "#type": "type",
          "#hn": "handlerName",
          "#ht": "handlerType",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: marshall(
          {
            ":entry": [entry],
            ":empty": [],
            ":type": "execution-log",
            ":hn": handlerName,
            ":ht": handlerType,
            ":ttl": computeTtl(),
          },
          { removeUndefinedValues: true }
        ),
      });
    } catch (err) {
      console.error("[effortless] Failed to write platform record:", err);
    }
  };

  return {
    tableName,

    async appendExecution(handlerName, handlerType, entry) {
      await appendToList(handlerName, handlerType, "executions", entry);
    },

    async appendError(handlerName, handlerType, entry) {
      await appendToList(handlerName, handlerType, "errors", entry);
    },

    async get<T extends PlatformEntity>(pk: string, sk: string): Promise<T | undefined> {
      const result = await getClient().getItem({
        TableName: tableName,
        Key: marshall({ pk, sk }),
      });
      return result.Item ? (unmarshall(result.Item) as T) : undefined;
    },

    async query<T extends PlatformEntity>(pk: string, skPrefix?: string): Promise<T[]> {
      const names: Record<string, string> = { "#pk": "pk" };
      const values: Record<string, unknown> = { ":pk": pk };
      let keyCondition = "#pk = :pk";

      if (skPrefix) {
        names["#sk"] = "sk";
        values[":sk"] = skPrefix;
        keyCondition += " AND begins_with(#sk, :sk)";
      }

      const result = await getClient().query({
        TableName: tableName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      });

      return (result.Items ?? []).map(item => unmarshall(item) as T);
    },

    async put(entity: PlatformEntity) {
      try {
        await getClient().putItem({
          TableName: tableName,
          Item: marshall(entity as Record<string, unknown>, { removeUndefinedValues: true }),
        });
      } catch (err) {
        console.error("[effortless] Failed to write platform record:", err);
      }
    },
  };
};
