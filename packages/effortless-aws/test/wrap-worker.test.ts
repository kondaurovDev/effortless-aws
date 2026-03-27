import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock SQS
const mockReceiveMessage = vi.fn()
const mockDeleteMessage = vi.fn()

vi.mock("@aws-sdk/client-sqs", () => ({
  SQS: class {
    receiveMessage = mockReceiveMessage
    deleteMessage = mockDeleteMessage
  },
}))

// Mock ECS
const mockEcsSend = vi.fn()

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: class {
    send = mockEcsSend
  },
  UpdateServiceCommand: class {
    constructor(public readonly input: any) {}
  },
}))

// Mock handler-utils
const mockBuildDeps = vi.fn()
const mockBuildParams = vi.fn()

vi.mock("~aws/runtime/handler-utils", () => ({
  buildDeps: (...args: any[]) => mockBuildDeps(...args),
  buildParams: (...args: any[]) => mockBuildParams(...args),
}))

// Mock process.exit to prevent test runner from dying
const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

import { wrapWorker } from "~aws/runtime/wrap-worker"

const originalEnv = process.env

const makeHandler = (overrides: Record<string, any> = {}) => ({
  __brand: "effortless-worker" as const,
  __spec: { concurrency: 1 },
  onMessage: vi.fn(),
  ...overrides,
})

describe("wrapWorker", () => {
  // Use fake timers to skip idle timeout waits
  let now = 0
  const originalDateNow = Date.now

  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildDeps.mockReturnValue(undefined)
    mockBuildParams.mockResolvedValue(undefined)
    mockEcsSend.mockResolvedValue({})
    mockDeleteMessage.mockResolvedValue({})
    now = 0
    Date.now = () => now
    // Make receiveMessage advance time past idle timeout on empty polls
    mockReceiveMessage.mockImplementation(async () => {
      now += 100_000 // jump 100s — well past the 10s idle timeout
      return { Messages: [] }
    })
    process.env = {
      ...originalEnv,
      EFF_WORKER_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/worker.fifo",
      EFF_CLUSTER: "my-cluster",
      EFF_SERVICE: "my-service",
      EFF_IDLE_TIMEOUT: "10",
    }
  })

  afterEach(() => {
    process.env = originalEnv
    Date.now = originalDateNow
  })

  it("should throw if EFF_WORKER_QUEUE_URL is missing", async () => {
    delete process.env.EFF_WORKER_QUEUE_URL
    const handler = wrapWorker(makeHandler() as any)

    await expect(handler()).rejects.toThrow("EFF_WORKER_QUEUE_URL")
  })

  it("should throw if no onMessage handler", async () => {
    const handler = wrapWorker(makeHandler({ onMessage: undefined }) as any)

    await expect(handler()).rejects.toThrow("onMessage")
  })

  it("should process messages and delete on success", async () => {
    const onMessage = vi.fn()
    // First poll: return a message. Second poll: empty + time jump triggers idle timeout.
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [{
          Body: '{"taskId":"abc"}',
          ReceiptHandle: "rh-1",
          Attributes: { ApproximateReceiveCount: "1" },
        }],
      })
      .mockImplementation(async () => { now += 100_000; return { Messages: [] } })

    const handler = wrapWorker(makeHandler({ onMessage }) as any)
    await handler()

    expect(onMessage).toHaveBeenCalledWith({ taskId: "abc" }, {})
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/worker.fifo",
      ReceiptHandle: "rh-1",
    })
  })

  it("should run setup and pass context to onMessage", async () => {
    const onMessage = vi.fn()
    const setup = vi.fn().mockResolvedValue({ db: "pool" })
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [{ Body: '"hello"', ReceiptHandle: "rh-1", Attributes: {} }],
      })

    const handler = wrapWorker(makeHandler({ onMessage, setup }) as any)
    await handler()

    expect(setup).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith("hello", { db: "pool" })
  })

  it("should pass deps and config to setup", async () => {
    const setup = vi.fn().mockResolvedValue({})
    const onMessage = vi.fn()
    const deps = () => ({ ordersTable: {} })
    const config = { dbUrl: {} }
    mockBuildDeps.mockReturnValue({ ordersTable: "table-client" })
    mockBuildParams.mockResolvedValue({ dbUrl: "postgres://..." })
    // Default mockImplementation returns empty + time jump

    const handler = wrapWorker(makeHandler({ onMessage, setup, deps, config }) as any)
    await handler()

    expect(setup).toHaveBeenCalledWith({
      deps: { ordersTable: "table-client" },
      config: { dbUrl: "postgres://..." },
    })
  })

  it("should leave failed messages in queue for retry by default", async () => {
    const onMessage = vi.fn().mockRejectedValue(new Error("process failed"))
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [{ Body: '"msg1"', ReceiptHandle: "rh-1", Attributes: { ApproximateReceiveCount: "1" } }],
      })

    const handler = wrapWorker(makeHandler({ onMessage }) as any)
    await handler()

    // Should NOT delete — leave for retry
    expect(mockDeleteMessage).not.toHaveBeenCalled()
  })

  it("should delete message when onError returns 'delete'", async () => {
    const onMessage = vi.fn().mockRejectedValue(new Error("bad message"))
    const onError = vi.fn().mockReturnValue("delete")
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [{ Body: '"msg1"', ReceiptHandle: "rh-1", Attributes: { ApproximateReceiveCount: "2" } }],
      })

    const handler = wrapWorker(makeHandler({ onMessage, onError }) as any)
    await handler()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(Error),
      msg: "msg1",
      retryCount: 2,
    }))
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/worker.fifo",
      ReceiptHandle: "rh-1",
    })
  })

  it("should process concurrent messages (batch)", async () => {
    const onMessage = vi.fn()
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [
          { Body: '"a"', ReceiptHandle: "rh-a", Attributes: {} },
          { Body: '"b"', ReceiptHandle: "rh-b", Attributes: {} },
          { Body: '"c"', ReceiptHandle: "rh-c", Attributes: {} },
        ],
      })

    const handler = wrapWorker(makeHandler({ onMessage, __spec: { concurrency: 3 } }) as any)
    await handler()

    expect(onMessage).toHaveBeenCalledTimes(3)
    expect(mockDeleteMessage).toHaveBeenCalledTimes(3)
  })

  it("should handle partial batch failure", async () => {
    const onMessage = vi.fn()
      .mockResolvedValueOnce(undefined)          // "a" succeeds
      .mockRejectedValueOnce(new Error("fail"))  // "b" fails
      .mockResolvedValueOnce(undefined)           // "c" succeeds
    mockReceiveMessage
      .mockResolvedValueOnce({
        Messages: [
          { Body: '"a"', ReceiptHandle: "rh-a", Attributes: {} },
          { Body: '"b"', ReceiptHandle: "rh-b", Attributes: { ApproximateReceiveCount: "1" } },
          { Body: '"c"', ReceiptHandle: "rh-c", Attributes: {} },
        ],
      })

    const handler = wrapWorker(makeHandler({ onMessage }) as any)
    await handler()

    // Only "a" and "c" should be deleted
    expect(mockDeleteMessage).toHaveBeenCalledTimes(2)
    expect(mockDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ ReceiptHandle: "rh-a" }))
    expect(mockDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ ReceiptHandle: "rh-c" }))
  })

  it("should scale ECS to 0 on idle timeout", async () => {
    const handler = wrapWorker(makeHandler() as any)
    await handler()

    expect(mockEcsSend).toHaveBeenCalledTimes(1)
    const cmd = mockEcsSend.mock.calls[0]![0]
    expect(cmd.input).toEqual({
      cluster: "my-cluster",
      service: "my-service",
      desiredCount: 0,
    })
  })

  it("should call onCleanup before shutting down", async () => {
    const onCleanup = vi.fn()
    const handler = wrapWorker(makeHandler({ onCleanup }) as any)
    await handler()

    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it("should not throw if onCleanup throws", async () => {
    const onCleanup = vi.fn().mockRejectedValue(new Error("cleanup boom"))
    const handler = wrapWorker(makeHandler({ onCleanup }) as any)
    await handler()

    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it("should call process.exit(0) after shutdown", async () => {
    const handler = wrapWorker(makeHandler() as any)
    await handler()

    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it("should not fail ECS scale-down if cluster/service not set", async () => {
    delete process.env.EFF_CLUSTER
    delete process.env.EFF_SERVICE

    const handler = wrapWorker(makeHandler() as any)
    await handler()

    expect(mockEcsSend).not.toHaveBeenCalled()
  })
})
