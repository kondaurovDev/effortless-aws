import { Effect } from "effect";
import { extractConfigs, type ExtractedFunction } from "~/build/bundle";
import {
  Aws,
  ensureProjectApi,
  addRouteToApi,
  makeTags,
  resolveStage,
  type TagContext
} from "../aws";
import {
  type DeployInput,
  type DeployResult,
  type DeployAllResult,
  readSource,
  deployCoreLambda,
  ensureLayerAndExternal
} from "./shared";

// ============ HTTP handler deployment ============

type DeployLambdaInput = {
  input: DeployInput;
  fn: ExtractedFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
};

/** @internal */
export const deployLambda = ({ input, fn, layerArn, external, depsEnv, depsPermissions }: DeployLambdaInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = config.name ?? exportName;

    const { functionArn } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "http",
      ...(config.permissions ? { permissions: config.permissions } : {}),
      ...(config.memory ? { memory: config.memory } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {})
    });

    return { exportName, functionArn, config, handlerName };
  });

export const deploy = (input: DeployInput) =>
  Effect.gen(function* () {
    const source = yield* readSource(input);
    const configs = extractConfigs(source);

    if (configs.length === 0) {
      return yield* Effect.fail(new Error("Could not extract defineHttp config from source"));
    }

    // Find specific export or use first one
    const targetExport = input.exportName ?? "default";
    const fn = configs.find(c => c.exportName === targetExport) ?? configs[0]!;
    const config = fn.config;
    const handlerName = config.name ?? fn.exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName
    };

    yield* Effect.logInfo(`Deploying ${handlerName} to ${input.region} (${tagCtx.project}/${tagCtx.stage})`);

    // Ensure layer exists
    const { layerArn, external } = yield* ensureLayerAndExternal({
      project: input.project,
      stage: tagCtx.stage,
      region: input.region,
      projectDir: input.projectDir
    });

    // Deploy Lambda
    const { functionArn } = yield* deployLambda({
      input,
      fn,
      ...(layerArn ? { layerArn } : {}),
      ...(external.length > 0 ? { external } : {})
    });

    // Setup API Gateway
    yield* Effect.logInfo("Setting up API Gateway...");
    const { apiId } = yield* ensureProjectApi({
      projectName: input.project,
      stage: tagCtx.stage,
      region: input.region,
      tags: makeTags(tagCtx, "api-gateway")
    });

    const { apiUrl } = yield* addRouteToApi({
      apiId,
      region: input.region,
      functionArn,
      method: config.method,
      path: config.path
    });

    yield* Effect.logInfo(`Deployment complete! URL: ${apiUrl}`);

    return {
      exportName: fn.exportName,
      url: apiUrl,
      functionArn
    } satisfies DeployResult;
  }).pipe(
    Effect.provide(
      Aws.makeClients({
        lambda: { region: input.region },
        iam: { region: input.region },
        apigatewayv2: { region: input.region }
      })
    )
  );

export const deployAll = (input: DeployInput) =>
  Effect.gen(function* () {
    const source = yield* readSource(input);
    const functions = extractConfigs(source);

    if (functions.length === 0) {
      return yield* Effect.fail(new Error("No defineHttp exports found in source"));
    }

    yield* Effect.logInfo(`Found ${functions.length} HTTP handler(s) to deploy`);

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: "api"
    };

    // Ensure layer exists
    const { layerArn, external } = yield* ensureLayerAndExternal({
      project: input.project,
      stage: tagCtx.stage,
      region: input.region,
      projectDir: input.projectDir
    });

    // Create single API Gateway for project
    yield* Effect.logInfo("Setting up API Gateway...");
    const { apiId } = yield* ensureProjectApi({
      projectName: input.project,
      stage: tagCtx.stage,
      region: input.region,
      tags: makeTags(tagCtx, "api-gateway")
    });

    const apiUrl = `https://${apiId}.execute-api.${input.region}.amazonaws.com`;

    // Deploy all Lambdas and add routes
    const results: DeployResult[] = [];

    for (const fn of functions) {
      const { exportName, functionArn, config } = yield* deployLambda({
        input,
        fn,
        ...(layerArn ? { layerArn } : {}),
        ...(external.length > 0 ? { external } : {})
      });

      const { apiUrl: handlerUrl } = yield* addRouteToApi({
        apiId,
        region: input.region,
        functionArn,
        method: config.method,
        path: config.path
      });

      results.push({ exportName, url: handlerUrl, functionArn });

      yield* Effect.logInfo(`  ${config.method} ${config.path} → ${config.name}`);
    }

    yield* Effect.logInfo(`Deployment complete! API: ${apiUrl}`);

    return {
      apiId,
      apiUrl,
      handlers: results
    } satisfies DeployAllResult;
  }).pipe(
    Effect.provide(
      Aws.makeClients({
        lambda: { region: input.region },
        iam: { region: input.region },
        apigatewayv2: { region: input.region }
      })
    )
  );
