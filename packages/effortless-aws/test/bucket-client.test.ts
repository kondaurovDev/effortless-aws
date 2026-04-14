import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock S3 client
const mockPutObject = vi.fn()
const mockGetObject = vi.fn()
const mockDeleteObject = vi.fn()
const mockListObjectsV2 = vi.fn()

vi.mock("@aws-sdk/client-s3", () => ({
  S3: class {
    putObject = mockPutObject
    getObject = mockGetObject
    deleteObject = mockDeleteObject
    listObjectsV2 = mockListObjectsV2
  },
}))

import { createBucketClient } from "~aws/runtime/bucket-client"

describe("createBucketClient", () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should expose the bucket name", async () => {
    const client = await createBucketClient("my-bucket")
    expect(client.bucketName).toBe("my-bucket")
  })

  describe("put", () => {
    it("should upload a string body", async () => {
      mockPutObject.mockResolvedValueOnce({})
      const client = await createBucketClient("my-bucket")

      await client.put("docs/readme.txt", "hello world")

      expect(mockPutObject).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: "docs/readme.txt",
        Body: Buffer.from("hello world"),
      })
    })

    it("should upload a buffer body", async () => {
      mockPutObject.mockResolvedValueOnce({})
      const client = await createBucketClient("my-bucket")
      const buf = Buffer.from([1, 2, 3])

      await client.put("bin/data.bin", buf)

      expect(mockPutObject).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: "bin/data.bin",
        Body: buf,
      })
    })

    it("should include contentType when provided", async () => {
      mockPutObject.mockResolvedValueOnce({})
      const client = await createBucketClient("my-bucket")

      await client.put("img/photo.jpg", Buffer.from([]), { contentType: "image/jpeg" })

      expect(mockPutObject).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: "img/photo.jpg",
        Body: Buffer.from([]),
        ContentType: "image/jpeg",
      })
    })
  })

  describe("get", () => {
    it("should return body and contentType", async () => {
      const chunks = [Buffer.from("hello")]
      mockGetObject.mockResolvedValueOnce({
        Body: { [Symbol.asyncIterator]: async function* () { yield* chunks } },
        ContentType: "text/plain",
      })
      const client = await createBucketClient("my-bucket")

      const result = await client.get("docs/readme.txt")

      expect(result).toEqual({
        body: Buffer.from("hello"),
        contentType: "text/plain",
      })
    })

    it("should return undefined for NoSuchKey", async () => {
      const error = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" })
      mockGetObject.mockRejectedValueOnce(error)
      const client = await createBucketClient("my-bucket")

      const result = await client.get("missing.txt")

      expect(result).toBeUndefined()
    })

    it("should return undefined for 404 status code", async () => {
      const error = Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })
      mockGetObject.mockRejectedValueOnce(error)
      const client = await createBucketClient("my-bucket")

      const result = await client.get("missing.txt")

      expect(result).toBeUndefined()
    })

    it("should throw on unexpected errors", async () => {
      mockGetObject.mockRejectedValueOnce(new Error("Access Denied"))
      const client = await createBucketClient("my-bucket")

      await expect(client.get("secret.txt")).rejects.toThrow("Access Denied")
    })
  })

  describe("delete", () => {
    it("should delete an object", async () => {
      mockDeleteObject.mockResolvedValueOnce({})
      const client = await createBucketClient("my-bucket")

      await client.delete("old-file.txt")

      expect(mockDeleteObject).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Key: "old-file.txt",
      })
    })
  })

  describe("list", () => {
    it("should list objects without prefix", async () => {
      mockListObjectsV2.mockResolvedValueOnce({
        Contents: [
          { Key: "file1.txt", Size: 100, LastModified: new Date("2025-01-01") },
          { Key: "file2.txt", Size: 200 },
        ],
      })
      const client = await createBucketClient("my-bucket")

      const items = await client.list()

      expect(items).toEqual([
        { key: "file1.txt", size: 100, lastModified: new Date("2025-01-01") },
        { key: "file2.txt", size: 200, lastModified: undefined },
      ])
      expect(mockListObjectsV2).toHaveBeenCalledWith({ Bucket: "my-bucket" })
    })

    it("should list objects with prefix", async () => {
      mockListObjectsV2.mockResolvedValueOnce({
        Contents: [{ Key: "uploads/photo.jpg", Size: 500 }],
      })
      const client = await createBucketClient("my-bucket")

      await client.list("uploads/")

      expect(mockListObjectsV2).toHaveBeenCalledWith({
        Bucket: "my-bucket",
        Prefix: "uploads/",
      })
    })

    it("should paginate when results are truncated", async () => {
      mockListObjectsV2
        .mockResolvedValueOnce({
          Contents: [{ Key: "a.txt", Size: 10 }],
          IsTruncated: true,
          NextContinuationToken: "token-1",
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: "b.txt", Size: 20 }],
          IsTruncated: false,
        })
      const client = await createBucketClient("my-bucket")

      const items = await client.list()

      expect(items).toHaveLength(2)
      expect(items[0]!.key).toBe("a.txt")
      expect(items[1]!.key).toBe("b.txt")
      expect(mockListObjectsV2).toHaveBeenCalledTimes(2)
      expect(mockListObjectsV2.mock.calls[1]![0]).toEqual({
        Bucket: "my-bucket",
        ContinuationToken: "token-1",
      })
    })

    it("should handle empty bucket", async () => {
      mockListObjectsV2.mockResolvedValueOnce({ Contents: undefined })
      const client = await createBucketClient("my-bucket")

      const items = await client.list()

      expect(items).toEqual([])
    })
  })

  describe("lazy initialization", () => {
    it("should reuse the same S3 client across calls", async () => {
      mockPutObject.mockResolvedValue({})
      const client = await createBucketClient("my-bucket")

      await client.put("a.txt", "a")
      await client.put("b.txt", "b")

      // Both calls should use the same mock (same class instance)
      expect(mockPutObject).toHaveBeenCalledTimes(2)
    })
  })
})
