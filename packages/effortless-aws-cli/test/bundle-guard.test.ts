import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"

const distIndex = path.resolve(__dirname, "../../effortless-aws/dist/index.js")

describe("bundle guard: dist/index.js", () => {

  it("should not import from 'effect' or '@effect/*'", () => {
    const content = fs.readFileSync(distIndex, "utf-8")
    const effectImports = content.match(/from\s+["'](?:effect|@effect\/[^"']+)["']/g)
    expect(effectImports, "dist/index.js must not import effect — move heavy deps out of the public API").toBeNull()
  })

  it("should not import from '@aws-sdk/*'", () => {
    const content = fs.readFileSync(distIndex, "utf-8")
    const awsImports = content.match(/from\s+["']@aws-sdk\/[^"']+["']/g)
    expect(awsImports, "dist/index.js must not import @aws-sdk — move heavy deps out of the public API").toBeNull()
  })
})
