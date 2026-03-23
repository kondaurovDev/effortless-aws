import { describe, it, expect } from "vitest"
import { Effect, Exit, Logger, LogLevel } from "effect"
import { NodeContext } from "@effect/platform-node"
import * as path from "path"

import { deploy, deployTable } from "~cli/deploy/deploy"

const projectDir = path.resolve(__dirname, "..")
const region = process.env.AWS_REGION ?? "eu-central-1"

const RUN_INTEGRATION = process.env.RUN_INTEGRATION ?? false

describe.skipIf(!RUN_INTEGRATION)("deploy integration", () => {

  it("should deploy single function with default export", async () => {
    const result = await Effect.runPromiseExit(
      deploy({
        projectDir,
        file: "test/functions/hello-world.ts",
        project: "effortless-test",
        stage: "dev",
        region
      }).pipe(
        Logger.withMinimumLogLevel(LogLevel.Info),
        Effect.provide(NodeContext.layer),
      )
    );

    if (Exit.isFailure(result)) {
      console.error("Deployment failed:", result.cause);
      expect.fail("Deployment failed");
    }

    expect(result.value.url).toBeDefined();
    expect(result.value.functionArn).toContain("arn:aws:lambda");

    console.log("\n=== Deployment Complete ===");
    console.log("URL:", result.value.url);
    console.log("Function ARN:", result.value.functionArn);
    console.log("\nTry it:");
    console.log(`  curl ${result.value.url}`);
  }, 120000);

  it("should deploy table with stream handler", async () => {
    const result = await Effect.runPromiseExit(
      deployTable({
        projectDir,
        file: "test/functions/orders-table.ts",
        project: "effortless-test",
        stage: "dev",
        region
      }).pipe(
        Logger.withMinimumLogLevel(LogLevel.Info),
        Effect.provide(NodeContext.layer),
      )
    );

    if (Exit.isFailure(result)) {
      console.error("Table deployment failed:", result.cause);
      expect.fail("Table deployment failed");
    }

    expect(result.value.tableArn).toContain("arn:aws:dynamodb");
    expect(result.value.streamArn).toContain("stream");
    expect(result.value.functionArn).toContain("arn:aws:lambda");

    console.log("\n=== Table Deployment Complete ===");
    console.log("Table ARN:", result.value.tableArn);
    console.log("Stream ARN:", result.value.streamArn);
    console.log("Function ARN:", result.value.functionArn);
  }, 180000);

});
