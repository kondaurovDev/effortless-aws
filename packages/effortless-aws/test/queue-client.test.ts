import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock SQS client
const mockGetQueueUrl = vi.fn()
const mockSendMessage = vi.fn()
const mockSendMessageBatch = vi.fn()

vi.mock("@aws-sdk/client-sqs", () => ({
  SQS: class {
    getQueueUrl = mockGetQueueUrl
    sendMessage = mockSendMessage
    sendMessageBatch = mockSendMessageBatch
  },
}))

import { createQueueClient } from "~aws/runtime/queue-client"

describe("createQueueClient", () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetQueueUrl.mockResolvedValue({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue.fifo" })
  })

  it("should expose the queue name", async () => {
    const client = await createQueueClient("test-queue")
    expect(client.queueName).toBe("test-queue")
  })

  describe("send", () => {
    it("should send a message with groupId", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      const client = await createQueueClient<{ orderId: string }>("orders")

      await client.send({ body: { orderId: "123" }, groupId: "user-1" })

      expect(mockGetQueueUrl).toHaveBeenCalledWith({ QueueName: "orders.fifo" })
      expect(mockSendMessage).toHaveBeenCalledWith({
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue.fifo",
        MessageBody: JSON.stringify({ orderId: "123" }),
        MessageGroupId: "user-1",
      })
    })

    it("should include deduplicationId when provided", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      const client = await createQueueClient("orders")

      await client.send({ body: { id: 1 }, groupId: "g1", deduplicationId: "dedup-1" })

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ MessageDeduplicationId: "dedup-1" })
      )
    })

    it("should include message attributes when provided", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      const client = await createQueueClient("orders")

      await client.send({
        body: { id: 1 },
        groupId: "g1",
        messageAttributes: {
          type: { dataType: "String", stringValue: "order.created" },
        },
      })

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          MessageAttributes: {
            type: { DataType: "String", StringValue: "order.created" },
          },
        })
      )
    })

    it("should cache the queue URL across calls", async () => {
      mockSendMessage.mockResolvedValue({})
      const client = await createQueueClient("orders")

      await client.send({ body: { id: 1 }, groupId: "g1" })
      await client.send({ body: { id: 2 }, groupId: "g2" })

      expect(mockGetQueueUrl).toHaveBeenCalledTimes(1)
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
  })

  describe("sendBatch", () => {
    it("should send a batch of messages", async () => {
      mockSendMessageBatch.mockResolvedValueOnce({ Failed: [] })
      const client = await createQueueClient<{ id: number }>("orders")

      await client.sendBatch([
        { body: { id: 1 }, groupId: "g1" },
        { body: { id: 2 }, groupId: "g2" },
      ])

      expect(mockSendMessageBatch).toHaveBeenCalledWith({
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue.fifo",
        Entries: [
          { Id: "0", MessageBody: '{"id":1}', MessageGroupId: "g1" },
          { Id: "1", MessageBody: '{"id":2}', MessageGroupId: "g2" },
        ],
      })
    })

    it("should include deduplicationId in batch entries", async () => {
      mockSendMessageBatch.mockResolvedValueOnce({ Failed: [] })
      const client = await createQueueClient("orders")

      await client.sendBatch([
        { body: { id: 1 }, groupId: "g1", deduplicationId: "d1" },
      ])

      expect(mockSendMessageBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          Entries: [
            expect.objectContaining({ MessageDeduplicationId: "d1" }),
          ],
        })
      )
    })

    it("should throw when some messages fail", async () => {
      mockSendMessageBatch.mockResolvedValueOnce({
        Failed: [
          { Id: "1", Message: "throttled" },
          { Id: "2", Message: "invalid" },
        ],
      })
      const client = await createQueueClient("orders")

      await expect(
        client.sendBatch([
          { body: { id: 1 }, groupId: "g1" },
          { body: { id: 2 }, groupId: "g2" },
          { body: { id: 3 }, groupId: "g3" },
        ])
      ).rejects.toThrow("Failed to send 2 message(s)")
    })

    it("should not throw when Failed is undefined", async () => {
      mockSendMessageBatch.mockResolvedValueOnce({})
      const client = await createQueueClient("orders")

      await expect(
        client.sendBatch([{ body: { id: 1 }, groupId: "g1" }])
      ).resolves.toBeUndefined()
    })
  })
})
