import { describe, it, expect, vi, beforeEach } from "vitest"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"

// Mock DynamoDB client
const mockPutItem = vi.fn();
const mockGetItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockUpdateItem = vi.fn();
const mockQuery = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {
    putItem = mockPutItem;
    getItem = mockGetItem;
    deleteItem = mockDeleteItem;
    updateItem = mockUpdateItem;
    query = mockQuery;
  },
}));

import { createTableClient } from "~aws/runtime/table-client"

type OrderData = { tag: string; amount: number; status: string; tags?: string[] };

describe("createTableClient (single-table design)", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should expose the table name", async () => {
    const client = await createTableClient<OrderData>("my-table");
    expect(client.tableName).toBe("my-table");
  });

  describe("put", () => {

    it("should auto-extract tag from data.tag and marshall full item", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.put({ pk: "USER#1", sk: "ORDER#1", data: { tag: "order", amount: 100, status: "new" } });

      expect(mockPutItem).toHaveBeenCalledWith({
        TableName: "orders",
        Item: marshall({ pk: "USER#1", sk: "ORDER#1", tag: "order", data: { tag: "order", amount: 100, status: "new" } }, { removeUndefinedValues: true }),
      });
    });

    it("should include ttl when provided", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.put({ pk: "USER#1", sk: "ORDER#1", data: { tag: "order", amount: 50, status: "new" }, ttl: 1700000000 });

      const call = mockPutItem.mock.calls[0]![0];
      const item = unmarshall(call.Item);
      expect(item.ttl).toBe(1700000000);
    });

    it("should use custom tagField to extract tag from data", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = await createTableClient<{ type: string; amount: number }>("orders", { tagField: "type" });

      await client.put({ pk: "USER#1", sk: "ORDER#1", data: { type: "order", amount: 100 } });

      const call = mockPutItem.mock.calls[0]![0];
      const item = unmarshall(call.Item);
      expect(item.tag).toBe("order");
    });

    it("should throw when tag field is missing from data", async () => {
      const client = await createTableClient<{ amount: number; status: string }>("orders");
      await expect(
        client.put({ pk: "USER#1", sk: "ORDER#1", data: { amount: 100, status: "new" } })
      ).rejects.toThrow('tag is required: data must include a "tag" field');
    });

    it("should throw with custom tagField name in error message", async () => {
      const client = await createTableClient<{ amount: number }>("orders", { tagField: "type" });
      await expect(
        client.put({ pk: "USER#1", sk: "ORDER#1", data: { amount: 100 } })
      ).rejects.toThrow('tag is required: data must include a "type" field');
    });

    it("should add ConditionExpression when ifNotExists is true", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.put(
        { pk: "USER#1", sk: "ORDER#1", data: { tag: "order", amount: 100, status: "new" } },
        { ifNotExists: true },
      );

      expect(mockPutItem).toHaveBeenCalledWith(expect.objectContaining({
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    });

    it("should not add ConditionExpression when ifNotExists is false or omitted", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.put({ pk: "USER#1", sk: "ORDER#1", data: { tag: "order", amount: 100, status: "new" } });

      const call = mockPutItem.mock.calls[0]![0];
      expect(call.ConditionExpression).toBeUndefined();
    });

  });

  describe("get", () => {

    it("should return TableItem when found", async () => {
      mockGetItem.mockResolvedValueOnce({
        Item: marshall({ pk: "USER#1", sk: "ORDER#1", tag: "order", data: { amount: 100, status: "new" } }),
      });

      const client = await createTableClient<OrderData>("orders");
      const result = await client.get({ pk: "USER#1", sk: "ORDER#1" });

      expect(mockGetItem).toHaveBeenCalledWith({
        TableName: "orders",
        Key: marshall({ pk: "USER#1", sk: "ORDER#1" }, { removeUndefinedValues: true }),
      });
      expect(result).toEqual({ pk: "USER#1", sk: "ORDER#1", tag: "order", data: { amount: 100, status: "new" } });
    });

    it("should return undefined when item not found", async () => {
      mockGetItem.mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      const result = await client.get({ pk: "USER#1", sk: "ORDER#999" });

      expect(result).toBeUndefined();
    });

  });

  describe("delete", () => {

    it("should call deleteItem with pk + sk", async () => {
      mockDeleteItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.delete({ pk: "USER#1", sk: "ORDER#1" });

      expect(mockDeleteItem).toHaveBeenCalledWith({
        TableName: "orders",
        Key: marshall({ pk: "USER#1", sk: "ORDER#1" }, { removeUndefinedValues: true }),
      });
    });

  });

  describe("update", () => {

    it("should auto-prefix data. for set fields", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        set: { status: "shipped" },
      });

      expect(mockUpdateItem).toHaveBeenCalledWith({
        TableName: "orders",
        Key: marshall({ pk: "USER#1", sk: "ORDER#1" }, { removeUndefinedValues: true }),
        UpdateExpression: "SET #data.#a0 = :v0",
        ExpressionAttributeNames: { "#data": "data", "#a0": "status" },
        ExpressionAttributeValues: marshall({ ":v0": "shipped" }, { removeUndefinedValues: true }),
      });
    });

    it("should auto-prefix data. for append fields", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        append: { tags: ["urgent"] },
      });

      expect(mockUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: "SET #data.#a0 = list_append(if_not_exists(#data.#a0, :empty0), :v0)",
        ExpressionAttributeNames: { "#data": "data", "#a0": "tags" },
      }));
    });

    it("should auto-prefix data. for remove fields", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        remove: ["tags"],
      });

      expect(mockUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: "REMOVE #data.#a0",
        ExpressionAttributeNames: { "#data": "data", "#a0": "tags" },
      }));
    });

    it("should update top-level tag", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        tag: "shipped-order",
      });

      expect(mockUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: "SET #tag = :tagVal",
        ExpressionAttributeNames: { "#tag": "tag" },
        ExpressionAttributeValues: marshall({ ":tagVal": "shipped-order" }, { removeUndefinedValues: true }),
      }));
    });

    it("should update top-level ttl", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        ttl: 1700000000,
      });

      expect(mockUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: "SET #ttl = :ttlVal",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: marshall({ ":ttlVal": 1700000000 }, { removeUndefinedValues: true }),
      }));
    });

    it("should remove ttl when null", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        ttl: null,
      });

      expect(mockUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: "REMOVE #ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
      }));
    });

    it("should combine data fields with top-level fields", async () => {
      mockUpdateItem.mockResolvedValueOnce({});
      const client = await createTableClient<OrderData>("orders");

      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        set: { status: "shipped" },
        tag: "shipped-order",
        ttl: 1700000000,
      });

      const call = mockUpdateItem.mock.calls[0]![0];
      expect(call.UpdateExpression).toBe("SET #data.#a0 = :v0, #tag = :tagVal, #ttl = :ttlVal");
    });

    it("should no-op when no actions", async () => {
      const client = await createTableClient<OrderData>("orders");
      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {});
      expect(mockUpdateItem).not.toHaveBeenCalled();
    });

    it("should retry with full data map on ValidationException", async () => {
      mockUpdateItem
        .mockRejectedValueOnce(Object.assign(new Error("ValidationException"), { name: "ValidationException" }))
        .mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        set: { status: "shipped", amount: 200 },
      });

      expect(mockUpdateItem).toHaveBeenCalledTimes(2);
      const retryCall = mockUpdateItem.mock.calls[1]![0];
      expect(retryCall.UpdateExpression).toBe("SET #data = :fullData");
      const retryValues = unmarshall(retryCall.ExpressionAttributeValues);
      expect(retryValues[":fullData"]).toEqual({ status: "shipped", amount: 200 });
    });

    it("should retry with tag + ttl alongside full data on ValidationException", async () => {
      mockUpdateItem
        .mockRejectedValueOnce(Object.assign(new Error("ValidationException"), { name: "ValidationException" }))
        .mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        set: { status: "shipped" },
        tag: "shipped-order",
        ttl: 1700000000,
      });

      expect(mockUpdateItem).toHaveBeenCalledTimes(2);
      const retryCall = mockUpdateItem.mock.calls[1]![0];
      expect(retryCall.UpdateExpression).toBe("SET #data = :fullData, #tag = :tagVal, #ttl = :ttlVal");
    });

    it("should retry with REMOVE ttl on ValidationException when ttl is null", async () => {
      mockUpdateItem
        .mockRejectedValueOnce(Object.assign(new Error("ValidationException"), { name: "ValidationException" }))
        .mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      await client.update({ pk: "USER#1", sk: "ORDER#1" }, {
        set: { status: "archived" },
        ttl: null,
      });

      expect(mockUpdateItem).toHaveBeenCalledTimes(2);
      const retryCall = mockUpdateItem.mock.calls[1]![0];
      expect(retryCall.UpdateExpression).toBe("SET #data = :fullData REMOVE #ttl");
    });

    it("should rethrow non-ValidationException errors", async () => {
      mockUpdateItem.mockRejectedValueOnce(new Error("AccessDeniedException"));

      const client = await createTableClient<OrderData>("orders");
      await expect(
        client.update({ pk: "USER#1", sk: "ORDER#1" }, { set: { status: "x" } })
      ).rejects.toThrow("AccessDeniedException");
    });

    it("should not retry when only top-level fields change (no data alias)", async () => {
      mockUpdateItem.mockRejectedValueOnce(
        Object.assign(new Error("ValidationException"), { name: "ValidationException" })
      );

      const client = await createTableClient<OrderData>("orders");
      await expect(
        client.update({ pk: "USER#1", sk: "ORDER#1" }, { tag: "new-tag" })
      ).rejects.toThrow("ValidationException");
      expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    });

  });

  describe("query", () => {

    it("should query by pk only", async () => {
      mockQuery.mockResolvedValueOnce({
        Items: [
          marshall({ pk: "USER#1", sk: "ORDER#1", tag: "order", data: { amount: 100, status: "new" } }),
        ],
      });

      const client = await createTableClient<OrderData>("orders");
      const results = await client.query({ pk: "USER#1" });

      expect(mockQuery).toHaveBeenCalledWith({
        TableName: "orders",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: marshall({ ":pk": "USER#1" }, { removeUndefinedValues: true }),
      });
      expect(results).toEqual([
        { pk: "USER#1", sk: "ORDER#1", tag: "order", data: { amount: 100, status: "new" } },
      ]);
    });

    it("should query with exact sk match (string shorthand)", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.query({ pk: "USER#1", sk: "ORDER#1" });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk = :sk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: marshall({ ":pk": "USER#1", ":sk": "ORDER#1" }, { removeUndefinedValues: true }),
      }));
    });

    it("should query with begins_with", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.query({ pk: "USER#1", sk: { begins_with: "ORDER#" } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      }));
    });

    it("should query with gt/gte/lt/lte", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });
      const client = await createTableClient<OrderData>("orders");

      await client.query({ pk: "USER#1", sk: { gt: "ORDER#100" } });
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk > :sk",
      }));

      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ Items: [] });
      await client.query({ pk: "USER#1", sk: { gte: "ORDER#100" } });
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk >= :sk",
      }));

      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ Items: [] });
      await client.query({ pk: "USER#1", sk: { lt: "ORDER#200" } });
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk < :sk",
      }));

      mockQuery.mockClear();
      mockQuery.mockResolvedValueOnce({ Items: [] });
      await client.query({ pk: "USER#1", sk: { lte: "ORDER#200" } });
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk <= :sk",
      }));
    });

    it("should query with between", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.query({ pk: "USER#1", sk: { between: ["ORDER#100", "ORDER#200"] } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :sk1 AND :sk2",
        ExpressionAttributeValues: marshall({ ":pk": "USER#1", ":sk1": "ORDER#100", ":sk2": "ORDER#200" }, { removeUndefinedValues: true }),
      }));
    });

    it("should pass limit and scanIndexForward", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.query({ pk: "USER#1", limit: 10, scanIndexForward: false });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 10,
          ScanIndexForward: false,
        })
      );
    });

    it("should return empty array when no items", async () => {
      mockQuery.mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      const results = await client.query({ pk: "USER#1" });

      expect(results).toEqual([]);
    });

  });

  describe("queryByTag", () => {

    it("should query GSI by tag only", async () => {
      mockQuery.mockResolvedValueOnce({
        Items: [
          marshall({ pk: "USER#1", sk: "PROFILE", tag: "user", data: { tag: "user", amount: 0, status: "active" } }),
        ],
      });

      const client = await createTableClient<OrderData>("orders");
      const results = await client.queryByTag({ tag: "user" });

      expect(mockQuery).toHaveBeenCalledWith({
        TableName: "orders",
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag",
        ExpressionAttributeNames: { "#tag": "tag" },
        ExpressionAttributeValues: marshall({ ":tag": "user" }, { removeUndefinedValues: true }),
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.tag).toBe("user");
    });

    it("should query GSI with pk exact match", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", pk: "USER#1" });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag AND #pk = :pk",
        ExpressionAttributeNames: { "#tag": "tag", "#pk": "pk" },
        ExpressionAttributeValues: marshall({ ":tag": "order", ":pk": "USER#1" }, { removeUndefinedValues: true }),
      }));
    });

    it("should query GSI with pk begins_with", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", pk: { begins_with: "USER#" } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag AND begins_with(#pk, :pk)",
      }));
    });

    it("should query GSI with pk between", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", pk: { between: ["USER#A", "USER#Z"] } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag AND #pk BETWEEN :pk1 AND :pk2",
        ExpressionAttributeValues: marshall({ ":tag": "order", ":pk1": "USER#A", ":pk2": "USER#Z" }, { removeUndefinedValues: true }),
      }));
    });

    it("should query GSI with pk gt", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", pk: { gt: "USER#100" } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag AND #pk > :pk",
        ExpressionAttributeNames: { "#tag": "tag", "#pk": "pk" },
      }));
    });

    it("should query GSI with pk lte", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", pk: { lte: "USER#Z" } });

      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: "tag-pk-index",
        KeyConditionExpression: "#tag = :tag AND #pk <= :pk",
      }));
    });

    it("should pass limit and scanIndexForward", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = await createTableClient<OrderData>("orders");
      await client.queryByTag({ tag: "order", limit: 5, scanIndexForward: false });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          IndexName: "tag-pk-index",
          Limit: 5,
          ScanIndexForward: false,
        })
      );
    });

    it("should return empty array when no items", async () => {
      mockQuery.mockResolvedValueOnce({});

      const client = await createTableClient<OrderData>("orders");
      const results = await client.queryByTag({ tag: "user" });

      expect(results).toEqual([]);
    });

  });

});
