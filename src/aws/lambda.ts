import { Effect, Schedule } from "effect";
import { Runtime } from "@aws-sdk/client-lambda";
import * as crypto from "crypto";
import { lambda } from "./clients";
const computeCodeHash = (code: Uint8Array): string =>
  crypto.createHash("sha256").update(code).digest("base64");

export type LambdaConfig = {
  project: string;
  stage: string;
  name: string;
  region: string;
  roleArn: string;
  code: Uint8Array;
  memory: number;
  timeout: number;
  handler?: string;
  runtime?: Runtime;
  tags?: Record<string, string>;
  layers?: string[];
  environment?: Record<string, string>;
};

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
    const runtime = config.runtime ?? Runtime.nodejs22x;
    const layers = config.layers ?? [];
    const environment = config.environment ?? {};

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

      const configChanged =
        existingFunction.MemorySize !== memory ||
        existingFunction.Timeout !== timeout ||
        existingFunction.Handler !== handler ||
        existingFunction.Runtime !== runtime ||
        layersChanged ||
        envChanged;

      if (!codeChanged && !configChanged) {
        yield* Effect.logInfo(`Function ${functionName} unchanged, skipping update`);
        return existingFunction.FunctionArn!;
      }

      if (codeChanged) {
        yield* Effect.logInfo(`Updating function code: ${functionName}`);

        yield* lambda.make("update_function_code", {
          FunctionName: functionName,
          ZipFile: config.code
        });

        yield* waitForFunctionActive(functionName);
      } else {
        yield* Effect.logInfo(`Code unchanged: ${functionName}`);
      }

      if (configChanged) {
        yield* Effect.logInfo(`Updating function config: ${functionName}`);

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

      return existingFunction.FunctionArn!;
    }

    yield* Effect.logInfo(`Creating function: ${functionName}`);

    const createResult = yield* lambda.make("create_function", {
      FunctionName: functionName,
      Role: config.roleArn,
      Code: {
        ZipFile: config.code
      },
      Handler: handler,
      Runtime: runtime,
      MemorySize: memory,
      Timeout: timeout,
      Tags: config.tags,
      Layers: layers.length > 0 ? layers : undefined,
      Environment: Object.keys(environment).length > 0 ? { Variables: environment } : undefined
    });

    yield* waitForFunctionActive(functionName);

    return createResult.FunctionArn!;
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
        times: 30,
        schedule: Schedule.spaced("2 seconds")
      }
    );

    yield* Effect.logDebug(`Function ${functionName} is active`);
  });

export const deleteLambda = (functionName: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Deleting Lambda function: ${functionName}`);

    yield* lambda.make("delete_function", {
      FunctionName: functionName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.logDebug(`Function ${functionName} not found, skipping`)
      )
    );
  });
