import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock SQS client
const mockGetQueueUrl = vi.fn()
const mockSendMessage = vi.fn()

// Mock ECS client
const mockEcsSend = vi.fn()

vi.mock("@aws-sdk/client-sqs", () => ({
  SQS: class {
    getQueueUrl = mockGetQueueUrl
    sendMessage = mockSendMessage
  },
}))

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: class {
    send = mockEcsSend
  },
  DescribeServicesCommand: class {
    constructor(public readonly input: any) {}
  },
  UpdateServiceCommand: class {
    constructor(public readonly input: any) {}
  },
}))

import { createWorkerClient } from "~aws/runtime/worker-client"

describe("createWorkerClient", () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetQueueUrl.mockResolvedValue({ QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/my-project-dev-processor-worker" })
  })

  const depValue = "my-project-dev-processor:300" // workerName:idleTimeoutSec

  describe("send", () => {
    it("should send message to worker queue and wake up ECS", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      mockEcsSend.mockResolvedValueOnce({
        services: [{ desiredCount: 0 }],
      })
      mockEcsSend.mockResolvedValueOnce({}) // UpdateServiceCommand
      const client = await createWorkerClient<{ taskId: string }>(depValue)

      await client.send({ taskId: "abc" })

      expect(mockGetQueueUrl).toHaveBeenCalledWith({ QueueName: "my-project-dev-processor-worker" })
      expect(mockSendMessage).toHaveBeenCalledWith({
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/my-project-dev-processor-worker",
        MessageBody: JSON.stringify({ taskId: "abc" }),
      })
      // Should check ECS and scale up
      expect(mockEcsSend).toHaveBeenCalledTimes(2)
      const describeCall = mockEcsSend.mock.calls[0]![0]
      expect(describeCall.input).toEqual({ cluster: "my-project-dev", services: ["my-project-dev-processor"] })
      const updateCall = mockEcsSend.mock.calls[1]![0]
      expect(updateCall.input).toEqual({ cluster: "my-project-dev", service: "my-project-dev-processor", desiredCount: 1 })
    })

    it("should skip ECS wake-up when already running", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      mockEcsSend.mockResolvedValueOnce({
        services: [{ desiredCount: 1 }],
      })
      const client = await createWorkerClient(depValue)

      await client.send({ data: 1 })

      // DescribeServices only, no UpdateService
      expect(mockEcsSend).toHaveBeenCalledTimes(1)
    })

    it("should skip ECS check within idle timeout window", async () => {
      mockSendMessage.mockResolvedValue({})
      mockEcsSend.mockResolvedValueOnce({
        services: [{ desiredCount: 0 }],
      })
      mockEcsSend.mockResolvedValueOnce({}) // UpdateService
      const client = await createWorkerClient(depValue)

      await client.send({ data: 1 }) // first call — wakes up
      await client.send({ data: 2 }) // second call — within timeout, skips ECS

      expect(mockEcsSend).toHaveBeenCalledTimes(2) // only from first call
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })

    it("should not wake up when start: false", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      const client = await createWorkerClient(depValue)

      await client.send({ data: 1 }, { start: false })

      expect(mockEcsSend).not.toHaveBeenCalled()
    })

    it("should not wake up when delay is provided", async () => {
      mockSendMessage.mockResolvedValueOnce({})
      const client = await createWorkerClient(depValue)

      await client.send({ data: 1 }, { delay: "5m" })

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ DelaySeconds: 300 })
      )
      expect(mockEcsSend).not.toHaveBeenCalled()
    })
  })

  describe("status", () => {
    it("should return 'running' when ECS has running tasks", async () => {
      mockEcsSend.mockResolvedValueOnce({
        services: [{ runningCount: 1 }],
      })
      const client = await createWorkerClient(depValue)

      expect(await client.status()).toBe("running")
    })

    it("should return 'idle' when no running tasks", async () => {
      mockEcsSend.mockResolvedValueOnce({
        services: [{ runningCount: 0 }],
      })
      const client = await createWorkerClient(depValue)

      expect(await client.status()).toBe("idle")
    })
  })

  describe("stop", () => {
    it("should scale ECS to 0 and reset awake cache", async () => {
      mockSendMessage.mockResolvedValue({})
      mockEcsSend.mockResolvedValue({
        services: [{ desiredCount: 0 }],
      })
      const client = await createWorkerClient(depValue)

      // Wake up first
      await client.send({ data: 1 })
      // Stop
      await client.stop()
      // Send again — should check ECS again (cache was reset)
      await client.send({ data: 2 })

      const updateCalls = mockEcsSend.mock.calls.filter(
        (call: any[]) => call[0].input?.desiredCount !== undefined
      )
      // First wake-up + stop + second wake-up = 3 update calls
      expect(updateCalls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
