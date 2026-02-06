import { describe, it, expect } from "vitest"
import { Effect, Exit, Logger, LogLevel } from "effect"
import * as path from "path"

import { deploy, deployAll, deployTable } from "~/deploy/deploy"

const projectDir = path.resolve(__dirname, "..")
const region = process.env.AWS_REGION ?? "eu-central-1"

const RUN_INTEGRATION = process.env.RUN_INTEGRATION ?? true

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
        Logger.withMinimumLogLevel(LogLevel.Info)
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

  it("should deploy multiple functions from one file", async () => {
    const result = await Effect.runPromiseExit(
      deployAll({
        projectDir,
        file: "test/functions/api.ts",
        project: "effortless-test",
        stage: "dev",
        region
      }).pipe(
        Logger.withMinimumLogLevel(LogLevel.Info)
      )
    );

    if (Exit.isFailure(result)) {
      console.error("Deployment failed:", result.cause);
      expect.fail("Deployment failed");
    }

    expect(result.value.handlers).toHaveLength(2);

    const helloFn = result.value.handlers.find(r => r.exportName === "hello");
    const userFn = result.value.handlers.find(r => r.exportName === "user");

    expect(helloFn).toBeDefined();
    expect(userFn).toBeDefined();

    console.log("\n=== Multi-function Deployment Complete ===");
    console.log("API ID:", result.value.apiId);
    console.log("API URL:", result.value.apiUrl);
    result.value.handlers.forEach(fn => {
      console.log(`${fn.exportName}: ${fn.url}`);
    });

    // Test hello endpoint
    const helloResponse = await fetch(helloFn!.url);
    const helloData = await helloResponse.json() as { message: string };
    expect(helloData.message).toBe("Hello World!");

    // Test user endpoint
    const userResponse = await fetch(userFn!.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", age: 25 })
    });
    const userData = await userResponse.json() as { greeting: string; isAdult: boolean };
    expect(userData.greeting).toBe("Hello Alice, you are 25 years old!");
    expect(userData.isAdult).toBe(true);
  }, 180000);

  it("should deploy table with stream handler", async () => {
    const result = await Effect.runPromiseExit(
      deployTable({
        projectDir,
        file: "test/functions/orders-table.ts",
        project: "effortless-test",
        stage: "dev",
        region
      }).pipe(
        Logger.withMinimumLogLevel(LogLevel.Info)
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
