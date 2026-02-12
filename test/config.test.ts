import { describe, it, expect } from "vitest"
import { getPatternsFromConfig } from "~/cli/config"
import type { EffortlessConfig } from "~/config"

const config = (handlers: EffortlessConfig["handlers"]): EffortlessConfig => ({
  name: "test",
  region: "eu-central-1",
  handlers,
})

describe("getPatternsFromConfig", () => {

  it("should return null when config is null", () => {
    expect(getPatternsFromConfig(null)).toBeNull()
  })

  it("should return null when handlers is undefined", () => {
    expect(getPatternsFromConfig({ name: "test", region: "eu-central-1" })).toBeNull()
  })

  it("should return null when handlers is an empty array", () => {
    expect(getPatternsFromConfig(config([]))).toBeNull()
  })

  // directory paths → append /**/*.ts

  it("should append /**/*.ts to a bare directory name", () => {
    expect(getPatternsFromConfig(config("src"))).toEqual(["src/**/*.ts"])
  })

  it("should append /**/*.ts to a directory path", () => {
    expect(getPatternsFromConfig(config("src/handlers"))).toEqual(["src/handlers/**/*.ts"])
  })

  it("should strip trailing slash before appending glob", () => {
    expect(getPatternsFromConfig(config("src/handlers/"))).toEqual(["src/handlers/**/*.ts"])
  })

  it("should handle multiple directory entries", () => {
    expect(getPatternsFromConfig(config(["src", "lib"]))).toEqual([
      "src/**/*.ts",
      "lib/**/*.ts",
    ])
  })

  // exact file paths → pass through as-is

  it("should pass through a .ts file path as-is", () => {
    expect(getPatternsFromConfig(config("src/handlers.ts"))).toEqual(["src/handlers.ts"])
  })

  it("should pass through a .tsx file path as-is", () => {
    expect(getPatternsFromConfig(config("src/handlers.tsx"))).toEqual(["src/handlers.tsx"])
  })

  it("should pass through multiple file paths", () => {
    expect(getPatternsFromConfig(config(["src/api.ts", "src/stream.ts"]))).toEqual([
      "src/api.ts",
      "src/stream.ts",
    ])
  })

  // glob patterns → pass through as-is

  it("should pass through a glob pattern with *", () => {
    expect(getPatternsFromConfig(config("src/**/*.ts"))).toEqual(["src/**/*.ts"])
  })

  it("should pass through a glob pattern with ?", () => {
    expect(getPatternsFromConfig(config("src/handler?.ts"))).toEqual(["src/handler?.ts"])
  })

  // mixed entries

  it("should handle mixed directories, files, and globs", () => {
    expect(getPatternsFromConfig(config([
      "src/handlers",
      "src/api.ts",
      "lib/**/*.ts",
    ]))).toEqual([
      "src/handlers/**/*.ts",
      "src/api.ts",
      "lib/**/*.ts",
    ])
  })

})
