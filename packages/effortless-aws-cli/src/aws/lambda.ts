import { Effect, Schedule } from "effect";
import { Architecture, Runtime } from "@aws-sdk/client-lambda";
import * as crypto from "crypto";
import { lambda } from "./clients";
const computeCodeHash = (code: Uint8Array): string =>
  crypto.createHash("sha256").update(code).digest("base64");

export type LambdaStatus = "created" | "updated" | "unchanged";

export type LambdaResult = {
  functionArn: string;
  status: LambdaStatus;
};

export type LambdaConfig = {
  project: string;
  stage: string;
  name: string;
  region: string;
  roleArn: string;
  code: Uint8Array;
  /** Memory in MB. @default 256 */
  memory: number;
  /** Timeout in seconds. @default 30 */
  timeout: number;
  /** @default "index.handler" */
  handler?: string;
  /** @default Runtime.nodejs24x */
  runtime?: Runtime;
  tags?: Record<string, string>;
  layers?: string[];
  environment?: Record<string, string>;
  /** @default Architecture.arm64 */
  architecture?: Architecture;
};

/**
 * All Lambdas are deployed with ARM64 (Graviton2) architecture.
 * ~20% cheaper than x86_64 with better price-performance.
 */

const arraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
};

export const ensureLambda = (
  config: LambdaConfig
) =>
  Effect.gen(function* () {
    const functionName = `${config.project}-${config.stage}-${config.name}`;
    const memory = config.memory;
    const timeout = config.timeout;
    const handler = config.handler ?? "index.handler";
    const runtime = config.runtime ?? Runtime.nodejs24x;
    const layers = config.layers ?? [];
    const environment = config.environment ?? {};
    const arch = config.architecture ?? Architecture.arm64;

    const existingFunction = yield* lambda.make("get_function", {
      FunctionName: functionName
    }).pipe(
      Effect.map(r => r.Configuration),
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed(undefined)
      )
    );

    if (existingFunction) {
      const existingHash = existingFunction.CodeSha256;
      const newHash = computeCodeHash(config.code);
      const codeChanged = existingHash !== newHash;

      const existingLayers = existingFunction.Layers?.map(l => l.Arn!).filter(Boolean) ?? [];
      const layersChanged = !arraysEqual(existingLayers, layers);

      const existingEnv = existingFunction.Environment?.Variables ?? {};
      const envKeys = [...new Set([...Object.keys(existingEnv), ...Object.keys(environment)])].sort();
      const envChanged = envKeys.some(k => existingEnv[k] !== environment[k]);

      const existingArch = existingFunction.Architectures?.[0] ?? Architecture.x86_64;
      const archChanged = existingArch !== arch;

      const configChanged =
        existingFunction.MemorySize !== memory ||
        existingFunction.Timeout !== timeout ||
        existingFunction.Handler !== handler ||
        existingFunction.Runtime !== runtime ||
        layersChanged ||
        envChanged;

      if (!codeChanged && !archChanged && !configChanged) {
        yield* Effect.logDebug(`Function ${functionName} unchanged, skipping update`);
        return { functionArn: existingFunction.FunctionArn!, status: "unchanged" as const };
      }

      if (codeChanged || archChanged) {
        yield* Effect.logDebug(`Updating function code: ${functionName}`);

        yield* lambda.make("update_function_code", {
          FunctionName: functionName,
          ZipFile: config.code,
          Architectures: [arch]
        });

        yield* waitForFunctionActive(functionName);
      } else {
        yield* Effect.logDebug(`Code unchanged: ${functionName}`);
      }

      if (configChanged) {
        yield* Effect.logDebug(`Updating function config: ${functionName}`);

        const updateConfig = lambda.make("update_function_configuration", {
          FunctionName: functionName,
          MemorySize: memory,
          Timeout: timeout,
          Handler: handler,
          Runtime: runtime,
          Layers: layers.length > 0 ? layers : undefined,
          Environment: Object.keys(environment).length > 0 ? { Variables: environment } : undefined
        });

        yield* updateConfig.pipe(
          Effect.catchIf(
            e => e._tag === "LambdaError" && e.is("ResourceConflictException"),
            () => waitForFunctionActive(functionName).pipe(Effect.andThen(updateConfig))
          )
        );

        yield* waitForFunctionActive(functionName);
      }

      // Sync tags on existing function
      if (config.tags) {
        yield* lambda.make("tag_resource", {
          Resource: existingFunction.FunctionArn!,
          Tags: config.tags
        });
      }

      return { functionArn: existingFunction.FunctionArn!, status: "updated" as const };
    }

    yield* Effect.logDebug(`Creating function: ${functionName}`);

    const createResult = yield* lambda.make("create_function", {
      FunctionName: functionName,
      Role: config.roleArn,
      Code: {
        ZipFile: config.code
      },
      Handler: handler,
      Runtime: runtime,
      Architectures: [arch],
      MemorySize: memory,
      Timeout: timeout,
      Tags: config.tags,
      Layers: layers.length > 0 ? layers : undefined,
      Environment: Object.keys(environment).length > 0 ? { Variables: environment } : undefined
    });

    yield* waitForFunctionActive(functionName);

    return { functionArn: createResult.FunctionArn!, status: "created" as const };
  });

const waitForFunctionActive = (functionName: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Waiting for function ${functionName} to be active`);

    yield* Effect.retry(
      lambda.make("get_function", { FunctionName: functionName }).pipe(
        Effect.flatMap(r => {
          const state = r.Configuration?.State;
          const updateStatus = r.Configuration?.LastUpdateStatus;
          if (state === "Active" && (!updateStatus || updateStatus === "Successful")) {
            return Effect.succeed(r);
          }
          return Effect.fail(new Error(`Function state: ${state}, update status: ${updateStatus}`));
        })
      ),
      {
        times: 15,
        schedule: Schedule.spaced("2 seconds")
      }
    );

    yield* Effect.logDebug(`Function ${functionName} is active`);
  });

export const publishVersion = (functionName: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Publishing version for: ${functionName}`);
    const result = yield* lambda.make("publish_version", {
      FunctionName: functionName,
    });
    return {
      versionArn: result.FunctionArn!,
      version: result.Version!,
    };
  });

// ============ Function URL ============

export const ensureFunctionUrl = (functionName: string) =>
  Effect.gen(function* () {
    // Check if Function URL already exists
    const existing = yield* lambda.make("get_function_url_config", {
      FunctionName: functionName,
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed(undefined)
      )
    );

    if (existing) {
      yield* Effect.logDebug(`Function URL already exists: ${existing.FunctionUrl}`);
      return { functionUrl: existing.FunctionUrl! };
    }

    yield* Effect.logDebug(`Creating Function URL for: ${functionName}`);
    const result = yield* lambda.make("create_function_url_config", {
      FunctionName: functionName,
      AuthType: "AWS_IAM",
      InvokeMode: "BUFFERED",
    });

    return { functionUrl: result.FunctionUrl! };
  });

export const addCloudFrontPermission = (functionName: string, distributionArn: string) =>
  Effect.gen(function* () {
    yield* lambda.make("add_permission", {
      FunctionName: functionName,
      StatementId: "cloudfront-oac",
      Action: "lambda:InvokeFunctionUrl",
      Principal: "cloudfront.amazonaws.com",
      SourceArn: distributionArn,
      FunctionUrlAuthType: "AWS_IAM",
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceConflictException"),
        () => Effect.logDebug(`CloudFront permission already exists for ${functionName}`)
      )
    );
  });

// ============ Cleanup ============

export const deleteLambda = (functionName: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting Lambda function: ${functionName}`);

    yield* lambda.make("delete_function", {
      FunctionName: functionName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.logDebug(`Function ${functionName} not found, skipping`)
      )
    );
  });
