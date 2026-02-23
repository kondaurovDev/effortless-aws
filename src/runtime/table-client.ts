import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { TableKey, TableItem, PutInput } from "~/handlers/handler-options";

/** Built-in GSI name: tag (PK) + pk (SK) */
const GSI_TAG_PK = "tag-pk-index";

/**
 * Sort key condition for TableClient.query()
 */
export type SkCondition =
  | string
  | { begins_with: string }
  | { gt: string }
  | { gte: string }
  | { lt: string }
  | { lte: string }
  | { between: [string, string] };

/**
 * Query parameters for TableClient.query()
 */
export type QueryParams = {
  /** Partition key value */
  pk: string;
  /** Optional sort key condition */
  sk?: SkCondition;
  /** Maximum number of items to return */
  limit?: number;
  /** Sort order (true = ascending, false = descending) */
  scanIndexForward?: boolean;
};

/**
 * Query parameters for TableClient.queryByTag() — cross-partition query via GSI.
 * Uses the built-in `tag-pk-index` GSI (tag as partition key, pk as sort key).
 */
export type QueryByTagParams = {
  /** Tag value (GSI partition key) — the entity type discriminant */
  tag: string;
  /** Optional pk condition (GSI sort key) */
  pk?: SkCondition;
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
 * `set`, `append`, and `remove` target fields inside the `data` attribute.
 * Effortless auto-prefixes `data.` in the DynamoDB expression.
 *
 * @typeParam T - Type of the domain data (the `data` attribute)
 */
export type UpdateActions<T> = {
  /** Set domain data fields (inside `data` attribute) */
  set?: Partial<T>;
  /** Append elements to list fields inside `data` (creates the list if it doesn't exist) */
  append?: Pick<Partial<T>, ArrayKeys<T>>;
  /** Remove fields from `data` */
  remove?: (keyof T)[];
  /** Update the top-level `tag` attribute */
  tag?: string;
  /** Update TTL (set number or null to remove) */
  ttl?: number | null;
};

/**
 * Typed DynamoDB table client for single-table design.
 *
 * All items follow the `{ pk, sk, tag, data, ttl? }` structure.
 * `T` is the domain data type stored in the `data` attribute.
 *
 * @typeParam T - Type of the domain data
 */
/**
 * Options for `put()` operation.
 */
export type PutOptions = {
  /** When true, the put fails if an item with the same pk+sk already exists. */
  ifNotExists?: boolean;
};

export type TableClient<T = Record<string, unknown>> = {
  /** Put an item. Tag is auto-extracted from `data[tagField]`. Use `ifNotExists` to prevent overwrites. */
  put(item: PutInput<T>, options?: PutOptions): Promise<void>;
  /** Get an item by pk + sk */
  get(key: TableKey): Promise<TableItem<T> | undefined>;
  /** Delete an item by pk + sk */
  delete(key: TableKey): Promise<void>;
  /** Update domain data fields without reading the full item */
  update(key: TableKey, actions: UpdateActions<T>): Promise<void>;
  /** Query by partition key with optional sort key condition */
  query(params: QueryParams): Promise<TableItem<T>[]>;
  /** Query by tag across all partitions via GSI (tag-pk-index). */
  queryByTag(params: QueryByTagParams): Promise<TableItem<T>[]>;
  /** The underlying DynamoDB table name */
  tableName: string;
};

const marshallKey = (key: TableKey) =>
  marshall(key as Record<string, unknown>, { removeUndefinedValues: true });

const buildSkCondition = (sk: SkCondition): { expression: string; names: Record<string, string>; values: Record<string, unknown> } => {
  const names: Record<string, string> = { "#sk": "sk" };

  if (typeof sk === "string") {
    return { expression: "AND #sk = :sk", names, values: { ":sk": sk } };
  }
  if ("begins_with" in sk) {
    return { expression: "AND begins_with(#sk, :sk)", names, values: { ":sk": sk.begins_with } };
  }
  if ("gt" in sk) {
    return { expression: "AND #sk > :sk", names, values: { ":sk": sk.gt } };
  }
  if ("gte" in sk) {
    return { expression: "AND #sk >= :sk", names, values: { ":sk": sk.gte } };
  }
  if ("lt" in sk) {
    return { expression: "AND #sk < :sk", names, values: { ":sk": sk.lt } };
  }
  if ("lte" in sk) {
    return { expression: "AND #sk <= :sk", names, values: { ":sk": sk.lte } };
  }
  if ("between" in sk) {
    return { expression: "AND #sk BETWEEN :sk1 AND :sk2", names, values: { ":sk1": sk.between[0], ":sk2": sk.between[1] } };
  }
  return { expression: "", names: {}, values: {} };
};

/**
 * Options for creating a TableClient.
 */
export type TableClientOptions = {
  /**
   * Name of the field in `data` to auto-extract as the top-level DynamoDB `tag` attribute.
   * Defaults to `"tag"`.
   */
  tagField?: string;
};

/**
 * Creates a typed TableClient for a DynamoDB table.
 * Lazily initializes the DynamoDB SDK client on first use (cold start friendly).
 */
export const createTableClient = <T = Record<string, unknown>>(tableName: string, options?: TableClientOptions): TableClient<T> => {
  let client: DynamoDB | null = null;
  const getClient = () => (client ??= new DynamoDB({}));
  const tagField = options?.tagField ?? "tag";

  return {
    tableName,

    async put(item: PutInput<T>, putOptions?: PutOptions) {
      // Auto-extract tag from data[tagField]
      const dataObj = item.data as Record<string, unknown>;
      const tag = (dataObj?.[tagField] as string) || "";
      if (!tag) throw new Error(`tag is required: data must include a "${tagField}" field`);

      const dynamoItem: Record<string, unknown> = {
        pk: item.pk,
        sk: item.sk,
        tag,
        data: item.data,
      };
      if (item.ttl !== undefined) dynamoItem.ttl = item.ttl;

      await getClient().putItem({
        TableName: tableName,
        Item: marshall(dynamoItem, { removeUndefinedValues: true }),
        ...(putOptions?.ifNotExists ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
      });
    },

    async get(key: TableKey) {
      const result = await getClient().getItem({
        TableName: tableName,
        Key: marshallKey(key),
      });
      return result.Item ? (unmarshall(result.Item) as TableItem<T>) : undefined;
    },

    async delete(key: TableKey) {
      await getClient().deleteItem({
        TableName: tableName,
        Key: marshallKey(key),
      });
    },

    async update(key: TableKey, actions: UpdateActions<T>) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const setClauses: string[] = [];
      const removeClauses: string[] = [];
      let counter = 0;

      // set/append/remove target fields inside data — auto-prefix #data.
      const DATA_ALIAS = "#data";
      let needsDataAlias = false;

      if (actions.set) {
        for (const [attr, val] of Object.entries(actions.set as Record<string, unknown>)) {
          needsDataAlias = true;
          const alias = `#a${counter}`;
          const valAlias = `:v${counter}`;
          names[alias] = attr;
          values[valAlias] = val;
          setClauses.push(`${DATA_ALIAS}.${alias} = ${valAlias}`);
          counter++;
        }
      }

      if (actions.append) {
        for (const [attr, val] of Object.entries(actions.append as Record<string, unknown>)) {
          needsDataAlias = true;
          const alias = `#a${counter}`;
          const valAlias = `:v${counter}`;
          const emptyAlias = `:empty${counter}`;
          names[alias] = attr;
          values[valAlias] = val;
          values[emptyAlias] = [];
          setClauses.push(`${DATA_ALIAS}.${alias} = list_append(if_not_exists(${DATA_ALIAS}.${alias}, ${emptyAlias}), ${valAlias})`);
          counter++;
        }
      }

      if (actions.remove) {
        for (const attr of actions.remove) {
          needsDataAlias = true;
          const alias = `#a${counter}`;
          names[alias] = attr as string;
          removeClauses.push(`${DATA_ALIAS}.${alias}`);
          counter++;
        }
      }

      if (needsDataAlias) {
        names[DATA_ALIAS] = "data";
      }

      // Top-level tag update
      if (actions.tag !== undefined) {
        names["#tag"] = "tag";
        values[":tagVal"] = actions.tag;
        setClauses.push("#tag = :tagVal");
      }

      // Top-level ttl update/remove
      if (actions.ttl !== undefined) {
        names["#ttl"] = "ttl";
        if (actions.ttl === null) {
          removeClauses.push("#ttl");
        } else {
          values[":ttlVal"] = actions.ttl;
          setClauses.push("#ttl = :ttlVal");
        }
      }

      const parts: string[] = [];
      if (setClauses.length) parts.push(`SET ${setClauses.join(", ")}`);
      if (removeClauses.length) parts.push(`REMOVE ${removeClauses.join(", ")}`);
      if (!parts.length) return;

      await getClient().updateItem({
        TableName: tableName,
        Key: marshallKey(key),
        UpdateExpression: parts.join(" "),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length
          ? { ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }) }
          : {}),
      });
    },

    async query(params: QueryParams) {
      const names: Record<string, string> = { "#pk": "pk" };
      const values: Record<string, unknown> = { ":pk": params.pk };
      let keyCondition = "#pk = :pk";

      if (params.sk !== undefined) {
        const skCond = buildSkCondition(params.sk);
        keyCondition += ` ${skCond.expression}`;
        Object.assign(names, skCond.names);
        Object.assign(values, skCond.values);
      }

      const result = await getClient().query({
        TableName: tableName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
        ...(params.limit ? { Limit: params.limit } : {}),
        ...(params.scanIndexForward !== undefined ? { ScanIndexForward: params.scanIndexForward } : {}),
      });

      return (result.Items ?? []).map(item => unmarshall(item) as TableItem<T>);
    },

    async queryByTag(params: QueryByTagParams) {
      const names: Record<string, string> = { "#tag": "tag" };
      const values: Record<string, unknown> = { ":tag": params.tag };
      let keyCondition = "#tag = :tag";

      if (params.pk !== undefined) {
        // Reuse buildSkCondition — it generates condition for the sort key.
        // In the GSI, pk is the sort key, so we remap #sk→#pk and :sk→:pk.
        const pkCond = buildSkCondition(params.pk);
        const remapped = pkCond.expression.replace(/#sk/g, "#pk").replace(/:sk/g, ":pk");
        keyCondition += ` ${remapped}`;
        for (const [k, v] of Object.entries(pkCond.names)) {
          names[k === "#sk" ? "#pk" : k] = v === "sk" ? "pk" : v;
        }
        for (const [k, v] of Object.entries(pkCond.values)) {
          values[k.replace(":sk", ":pk")] = v;
        }
      }

      const result = await getClient().query({
        TableName: tableName,
        IndexName: GSI_TAG_PK,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
        ...(params.limit ? { Limit: params.limit } : {}),
        ...(params.scanIndexForward !== undefined ? { ScanIndexForward: params.scanIndexForward } : {}),
      });

      return (result.Items ?? []).map(item => unmarshall(item) as TableItem<T>);
    },
  };
};
