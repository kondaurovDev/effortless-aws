import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

/**
 * Query parameters for TableClient.query()
 */
export type QueryParams = {
  /** Partition key name and value */
  pk: { name: string; value: unknown };
  /** Optional sort key condition */
  sk?: {
    name: string;
    condition: "=" | "begins_with" | "<" | ">" | "<=" | ">=";
    value: unknown;
  };
  /** Maximum number of items to return */
  limit?: number;
  /** Sort order (true = ascending, false = descending) */
  scanIndexForward?: boolean;
};

/** Extract keys of T whose values are arrays */
type ArrayKeys<T> = { [K in keyof T]: T[K] extends unknown[] ? K : never }[keyof T];

/**
 * Update actions for TableClient.update()
 *
 * @typeParam T - Type of the table items
 */
export type UpdateActions<T> = {
  /** Set attribute values (overwrites existing) */
  set?: Partial<T>;
  /** Append elements to list attributes (creates the list if it doesn't exist) */
  append?: Pick<Partial<T>, ArrayKeys<T>>;
  /** Remove attributes from the item */
  remove?: (keyof T)[];
};

/** Key attribute names for condition expression generation */
export type KeyConfig = {
  pk: string;
  sk?: string;
};

/** Result of a put operation with `overwrite: false` */
export type PutResult = { success: true } | { success: false; error: "ALREADY_EXISTS" };

/**
 * Typed DynamoDB table client injected via deps.
 *
 * @typeParam T - Type of the table items
 */
export type TableClient<T = Record<string, unknown>> = {
  /** Put a full item (upsert) */
  put(item: T): Promise<void>;
  /** Put a full item; when `overwrite: false`, returns a result instead of throwing on duplicate */
  put(item: T, options: { overwrite: false }): Promise<PutResult>;
  /** Get an item by its key attributes */
  get(key: Partial<T>): Promise<T | undefined>;
  /** Delete an item by its key attributes */
  delete(key: Partial<T>): Promise<void>;
  /** Update specific attributes without reading the full item */
  update(key: Partial<T>, actions: UpdateActions<T>): Promise<void>;
  /** Query by partition key with optional sort key condition */
  query(params: QueryParams): Promise<T[]>;
  /** The underlying DynamoDB table name */
  tableName: string;
};

/**
 * Creates a typed TableClient for a DynamoDB table.
 * Lazily initializes the DynamoDB SDK client on first use (cold start friendly).
 */
export const createTableClient = <T = Record<string, unknown>>(tableName: string, keys?: KeyConfig): TableClient<T> => {
  let client: DynamoDB | null = null;
  const getClient = () => (client ??= new DynamoDB({}));

  return {
    tableName,

    async put(item: T, options?: { overwrite: false }): Promise<any> {
      const params: Record<string, unknown> = {
        TableName: tableName,
        Item: marshall(item as Record<string, unknown>, { removeUndefinedValues: true }),
      };

      if (options?.overwrite === false) {
        if (!keys) throw new Error("Cannot use overwrite: false — key config not available");
        params.ConditionExpression = "attribute_not_exists(#pk)";
        params.ExpressionAttributeNames = { "#pk": keys.pk };
      }

      try {
        await getClient().putItem(params as any);
      } catch (err: unknown) {
        if (options?.overwrite === false && (err as any)?.name === "ConditionalCheckFailedException") {
          return { success: false, error: "ALREADY_EXISTS" } as PutResult;
        }
        throw err;
      }

      if (options?.overwrite === false) {
        return { success: true } as PutResult;
      }
    },

    async get(key: Partial<T>) {
      const result = await getClient().getItem({
        TableName: tableName,
        Key: marshall(key as Record<string, unknown>, { removeUndefinedValues: true }),
      });
      return result.Item ? (unmarshall(result.Item) as T) : undefined;
    },

    async delete(key: Partial<T>) {
      await getClient().deleteItem({
        TableName: tableName,
        Key: marshall(key as Record<string, unknown>, { removeUndefinedValues: true }),
      });
    },

    async update(key: Partial<T>, actions: UpdateActions<T>) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const setClauses: string[] = [];
      const removeClauses: string[] = [];
      let counter = 0;

      if (actions.set) {
        for (const [attr, val] of Object.entries(actions.set as Record<string, unknown>)) {
          const alias = `#a${counter}`;
          const valAlias = `:v${counter}`;
          names[alias] = attr;
          values[valAlias] = val;
          setClauses.push(`${alias} = ${valAlias}`);
          counter++;
        }
      }

      if (actions.append) {
        for (const [attr, val] of Object.entries(actions.append as Record<string, unknown>)) {
          const alias = `#a${counter}`;
          const valAlias = `:v${counter}`;
          const emptyAlias = `:empty${counter}`;
          names[alias] = attr;
          values[valAlias] = val;
          values[emptyAlias] = [];
          setClauses.push(`${alias} = list_append(if_not_exists(${alias}, ${emptyAlias}), ${valAlias})`);
          counter++;
        }
      }

      if (actions.remove) {
        for (const attr of actions.remove) {
          const alias = `#a${counter}`;
          names[alias] = attr as string;
          removeClauses.push(alias);
          counter++;
        }
      }

      const parts: string[] = [];
      if (setClauses.length) parts.push(`SET ${setClauses.join(", ")}`);
      if (removeClauses.length) parts.push(`REMOVE ${removeClauses.join(", ")}`);
      if (!parts.length) return;

      await getClient().updateItem({
        TableName: tableName,
        Key: marshall(key as Record<string, unknown>, { removeUndefinedValues: true }),
        UpdateExpression: parts.join(" "),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length
          ? { ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }) }
          : {}),
      });
    },

    async query(params: QueryParams) {
      const names: Record<string, string> = { "#pk": params.pk.name };
      const values: Record<string, unknown> = { ":pk": params.pk.value };
      let keyCondition = "#pk = :pk";

      if (params.sk) {
        names["#sk"] = params.sk.name;
        values[":sk"] = params.sk.value;
        if (params.sk.condition === "begins_with") {
          keyCondition += " AND begins_with(#sk, :sk)";
        } else {
          keyCondition += ` AND #sk ${params.sk.condition} :sk`;
        }
      }

      const result = await getClient().query({
        TableName: tableName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
        ...(params.limit ? { Limit: params.limit } : {}),
        ...(params.scanIndexForward !== undefined ? { ScanIndexForward: params.scanIndexForward } : {}),
      });

      return (result.Items ?? []).map(item => unmarshall(item) as T);
    },
  };
};
