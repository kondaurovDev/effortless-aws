import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock bucket-client
const mockBucketClient = { put: vi.fn(), get: vi.fn(), delete: vi.fn(), list: vi.fn(), bucketName: "self-bucket" }
vi.mock("~aws/runtime/bucket-client", () => ({
  createBucketClient: () => mockBucketClient,
}))

// Mock handler-utils
const mockPatchConsole = vi.fn()
const mockRestoreConsole = vi.fn()
const mockLogExecution = vi.fn()
const mockLogError = vi.fn()
const mockCommonArgs = vi.fn()

vi.mock("~aws/runtime/handler-utils", () => ({
  createHandlerRuntime: (_handler: any, _type: any, _logLevel: any, extraDeps?: () => Record<string, unknown>) => ({
    handlerName: "test-bucket",
    patchConsole: mockPatchConsole,
    restoreConsole: mockRestoreConsole,
    logExecution: mockLogExecution,
    logError: mockLogError,
    commonArgs: async () => {
      const base = await mockCommonArgs()
      const extra = extraDeps?.() ?? {}
      return { ctx: base.ctx, ...extra }
    },
  }),
}))

import { wrapBucket } from "~aws/runtime/wrap-bucket"

const originalEnv = process.env

const makeHandler = (overrides: Record<string, any> = {}) => ({
  __brand: "effortless-bucket" as const,
  __spec: { lambda: {} },
  onObjectCreated: vi.fn(),
  ...overrides,
})

const makeS3Event = (...records: { eventName: string; key: string; size?: number }[]) => ({
  Records: records.map(r => ({
    eventName: r.eventName,
    eventTime: "2025-01-01T00:00:00Z",
    s3: {
      bucket: { name: "my-bucket" },
      object: { key: r.key, size: r.size ?? 100, eTag: "abc" },
    },
  })),
})

describe("wrapBucket", () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockCommonArgs.mockResolvedValue({ ctx: undefined })
    process.env = { ...originalEnv, EFF_DEP_SELF: "bucket:self-bucket" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("should throw if neither onObjectCreated nor onObjectRemoved defined", () => {
    expect(() => wrapBucket(makeHandler({ onObjectCreated: undefined }) as any))
      .toThrow("onObjectCreated or onObjectRemoved")
  })

  it("should call onObjectCreated for ObjectCreated events", async () => {
    const onObjectCreated = vi.fn()
    const handler = wrapBucket(makeHandler({ onObjectCreated }) as any)

    await handler(makeS3Event({ eventName: "ObjectCreated:Put", key: "uploads/photo.jpg", size: 5000 }))

    expect(onObjectCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventName: "ObjectCreated:Put",
          key: "uploads/photo.jpg",
          size: 5000,
          bucketName: "my-bucket",
        }),
      })
    )
  })

  it("should call onObjectRemoved for ObjectRemoved events", async () => {
    const onObjectRemoved = vi.fn()
    const handler = wrapBucket(makeHandler({ onObjectCreated: undefined, onObjectRemoved }) as any)

    await handler(makeS3Event({ eventName: "ObjectRemoved:Delete", key: "old-file.txt" }))

    expect(onObjectRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventName: "ObjectRemoved:Delete",
          key: "old-file.txt",
        }),
      })
    )
  })

  it("should URL-decode S3 keys", async () => {
    const onObjectCreated = vi.fn()
    const handler = wrapBucket(makeHandler({ onObjectCreated }) as any)

    await handler(makeS3Event({ eventName: "ObjectCreated:Put", key: "path/my+file%20%282%29.txt" }))

    expect(onObjectCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          key: "path/my file (2).txt",
        }),
      })
    )
  })

  it("should process multiple records", async () => {
    const onObjectCreated = vi.fn()
    const handler = wrapBucket(makeHandler({ onObjectCreated }) as any)

    await handler(makeS3Event(
      { eventName: "ObjectCreated:Put", key: "a.txt" },
      { eventName: "ObjectCreated:Put", key: "b.txt" },
    ))

    expect(onObjectCreated).toHaveBeenCalledTimes(2)
  })

  it("should handle empty event", async () => {
    const onObjectCreated = vi.fn()
    const handler = wrapBucket(makeHandler({ onObjectCreated }) as any)

    await handler({ Records: [] })

    expect(onObjectCreated).not.toHaveBeenCalled()
    expect(mockLogExecution).toHaveBeenCalled()
  })

  it("should not throw when individual records fail (fire-and-forget)", async () => {
    const onObjectCreated = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("process failed"))
      .mockResolvedValueOnce(undefined)
    const handler = wrapBucket(makeHandler({ onObjectCreated }) as any)

    // Should not throw — errors are logged but not propagated
    await handler(makeS3Event(
      { eventName: "ObjectCreated:Put", key: "a.txt" },
      { eventName: "ObjectCreated:Put", key: "b.txt" },
      { eventName: "ObjectCreated:Put", key: "c.txt" },
    ))

    expect(onObjectCreated).toHaveBeenCalledTimes(3)
    expect(mockLogError).toHaveBeenCalled()
  })

  it("should call onCleanup after processing", async () => {
    const onCleanup = vi.fn()
    const handler = wrapBucket(makeHandler({ onCleanup }) as any)

    await handler(makeS3Event({ eventName: "ObjectCreated:Put", key: "test.txt" }))

    expect(onCleanup).toHaveBeenCalled()
  })

  it("should patch and restore console", async () => {
    const handler = wrapBucket(makeHandler() as any)

    await handler(makeS3Event({ eventName: "ObjectCreated:Put", key: "test.txt" }))

    expect(mockPatchConsole).toHaveBeenCalled()
    expect(mockRestoreConsole).toHaveBeenCalled()
  })
})
