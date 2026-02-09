import { describe, it, expect, vi, beforeEach } from "vitest"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"

// Mock DynamoDB client
const mockPutItem = vi.fn();
const mockGetItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockQuery = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: class {
    putItem = mockPutItem;
    getItem = mockGetItem;
    deleteItem = mockDeleteItem;
    query = mockQuery;
  },
}));

import { createTableClient } from "~/runtime/table-client"

type TestItem = { id: string; name: string; age: number };

describe("createTableClient", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should expose the table name", () => {
    const client = createTableClient<TestItem>("my-table");
    expect(client.tableName).toBe("my-table");
  });

  describe("put", () => {

    it("should call putItem with marshalled item", async () => {
      mockPutItem.mockResolvedValueOnce({});
      const client = createTableClient<TestItem>("orders");

      await client.put({ id: "1", name: "Alice", age: 30 });

      expect(mockPutItem).toHaveBeenCalledWith({
        TableName: "orders",
        Item: marshall({ id: "1", name: "Alice", age: 30 }, { removeUndefinedValues: true }),
      });
    });

  });

  describe("get", () => {

    it("should return unmarshalled item when found", async () => {
      mockGetItem.mockResolvedValueOnce({
        Item: marshall({ id: "1", name: "Alice", age: 30 }),
      });

      const client = createTableClient<TestItem>("orders");
      const result = await client.get({ id: "1" });

      expect(mockGetItem).toHaveBeenCalledWith({
        TableName: "orders",
        Key: marshall({ id: "1" }, { removeUndefinedValues: true }),
      });
      expect(result).toEqual({ id: "1", name: "Alice", age: 30 });
    });

    it("should return undefined when item not found", async () => {
      mockGetItem.mockResolvedValueOnce({});

      const client = createTableClient<TestItem>("orders");
      const result = await client.get({ id: "999" });

      expect(result).toBeUndefined();
    });

  });

  describe("delete", () => {

    it("should call deleteItem with marshalled key", async () => {
      mockDeleteItem.mockResolvedValueOnce({});
      const client = createTableClient<TestItem>("orders");

      await client.delete({ id: "1" });

      expect(mockDeleteItem).toHaveBeenCalledWith({
        TableName: "orders",
        Key: marshall({ id: "1" }, { removeUndefinedValues: true }),
      });
    });

  });

  describe("query", () => {

    it("should query by partition key", async () => {
      mockQuery.mockResolvedValueOnce({
        Items: [
          marshall({ id: "1", name: "Alice", age: 30 }),
          marshall({ id: "1", name: "Bob", age: 25 }),
        ],
      });

      const client = createTableClient<TestItem>("orders");
      const results = await client.query({
        pk: { name: "id", value: "1" },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        TableName: "orders",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "id" },
        ExpressionAttributeValues: marshall({ ":pk": "1" }, { removeUndefinedValues: true }),
      });
      expect(results).toEqual([
        { id: "1", name: "Alice", age: 30 },
        { id: "1", name: "Bob", age: 25 },
      ]);
    });

    it("should query with sort key condition", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = createTableClient<TestItem>("orders");
      await client.query({
        pk: { name: "id", value: "1" },
        sk: { name: "age", condition: ">", value: 20 },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        TableName: "orders",
        KeyConditionExpression: "#pk = :pk AND #sk > :sk",
        ExpressionAttributeNames: { "#pk": "id", "#sk": "age" },
        ExpressionAttributeValues: marshall({ ":pk": "1", ":sk": 20 }, { removeUndefinedValues: true }),
      });
    });

    it("should query with begins_with condition", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = createTableClient<TestItem>("orders");
      await client.query({
        pk: { name: "id", value: "1" },
        sk: { name: "name", condition: "begins_with", value: "Al" },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        TableName: "orders",
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        ExpressionAttributeNames: { "#pk": "id", "#sk": "name" },
        ExpressionAttributeValues: marshall({ ":pk": "1", ":sk": "Al" }, { removeUndefinedValues: true }),
      });
    });

    it("should pass limit and scanIndexForward", async () => {
      mockQuery.mockResolvedValueOnce({ Items: [] });

      const client = createTableClient<TestItem>("orders");
      await client.query({
        pk: { name: "id", value: "1" },
        limit: 10,
        scanIndexForward: false,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 10,
          ScanIndexForward: false,
        })
      );
    });

    it("should return empty array when no items", async () => {
      mockQuery.mockResolvedValueOnce({});

      const client = createTableClient<TestItem>("orders");
      const results = await client.query({
        pk: { name: "id", value: "1" },
      });

      expect(results).toEqual([]);
    });

  });

});
