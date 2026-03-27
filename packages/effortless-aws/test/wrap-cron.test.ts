import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock handler-utils
const mockPatchConsole = vi.fn()
const mockRestoreConsole = vi.fn()
const mockLogExecution = vi.fn()
const mockLogError = vi.fn()
const mockCommonArgs = vi.fn()

vi.mock("~aws/runtime/handler-utils", () => ({
  createHandlerRuntime: () => ({
    handlerName: "test-cron",
    patchConsole: mockPatchConsole,
    restoreConsole: mockRestoreConsole,
    logExecution: mockLogExecution,
    logError: mockLogError,
    commonArgs: mockCommonArgs,
  }),
}))

import { wrapCron } from "~aws/runtime/wrap-cron"

const makeHandler = (overrides: Record<string, any> = {}) => ({
  __brand: "effortless-cron" as const,
  __spec: { schedule: "rate(1 hour)", lambda: {} },
  onTick: vi.fn(),
  ...overrides,
})

describe("wrapCron", () => {

  beforeEach(() => {
    vi.clearAllMocks()
    mockCommonArgs.mockResolvedValue({ ctx: undefined })
  })

  it("should throw if no onTick defined", () => {
    expect(() => wrapCron(makeHandler({ onTick: undefined }) as any))
      .toThrow("onTick")
  })

  it("should call onTick", async () => {
    const onTick = vi.fn()
    const handler = wrapCron(makeHandler({ onTick }) as any)

    await handler()

    expect(onTick).toHaveBeenCalledTimes(1)
    expect(mockLogExecution).toHaveBeenCalled()
  })

  it("should pass setup context to onTick", async () => {
    const onTick = vi.fn()
    mockCommonArgs.mockResolvedValue({ ctx: { db: "pool" } })
    const handler = wrapCron(makeHandler({ onTick }) as any)

    await handler()

    expect(onTick).toHaveBeenCalledWith(expect.objectContaining({ db: "pool" }))
  })

  it("should re-throw errors from onTick", async () => {
    const onTick = vi.fn().mockRejectedValue(new Error("tick failed"))
    const handler = wrapCron(makeHandler({ onTick }) as any)

    await expect(handler()).rejects.toThrow("tick failed")
    expect(mockLogError).toHaveBeenCalled()
  })

  it("should call custom onError when onTick fails", async () => {
    const onError = vi.fn()
    const error = new Error("boom")
    const onTick = vi.fn().mockRejectedValue(error)
    const handler = wrapCron(makeHandler({ onTick, onError }) as any)

    await expect(handler()).rejects.toThrow("boom")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error }))
  })

  it("should call onCleanup after success", async () => {
    const onCleanup = vi.fn()
    const handler = wrapCron(makeHandler({ onCleanup }) as any)

    await handler()

    expect(onCleanup).toHaveBeenCalled()
  })

  it("should call onCleanup after error", async () => {
    const onCleanup = vi.fn()
    const onTick = vi.fn().mockRejectedValue(new Error("fail"))
    const handler = wrapCron(makeHandler({ onTick, onCleanup }) as any)

    await expect(handler()).rejects.toThrow("fail")
    expect(onCleanup).toHaveBeenCalled()
  })

  it("should not throw when onCleanup itself throws", async () => {
    const onCleanup = vi.fn().mockRejectedValue(new Error("cleanup error"))
    const handler = wrapCron(makeHandler({ onCleanup }) as any)

    // Should not throw — onCleanup error is swallowed
    await handler()
  })

  it("should patch and restore console", async () => {
    const handler = wrapCron(makeHandler() as any)

    await handler()

    expect(mockPatchConsole).toHaveBeenCalled()
    expect(mockRestoreConsole).toHaveBeenCalled()
  })

  it("should restore console even on error", async () => {
    const onTick = vi.fn().mockRejectedValue(new Error("fail"))
    const handler = wrapCron(makeHandler({ onTick }) as any)

    await expect(handler()).rejects.toThrow()
    expect(mockRestoreConsole).toHaveBeenCalled()
  })
})
