import { Effect } from "effect";
import { extractApiConfigs, type ExtractedApiFunction } from "~/build/bundle";
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
  readSource,
  deployCoreLambda,
  ensureLayerAndExternal
} from "./shared";

// ============ API handler deployment ============

type DeployApiLambdaInput = {
  input: DeployInput;
  fn: ExtractedApiFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

/** @internal */
export const deployApiFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployApiLambdaInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;

    const { functionArn, status } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "api",
      ...(config.permissions ? { permissions: config.permissions } : {}),
      ...(config.memory ? { memory: config.memory } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {})
    });

    return { exportName, functionArn, status, config, handlerName };
  });

export const deploy = (input: DeployInput) =>
  Effect.gen(function* () {
    const source = yield* readSource(input);
    const configs = extractApiConfigs(source);

    if (configs.length === 0) {
      return yield* Effect.fail(new Error("Could not extract defineApi config from source"));
    }

    const targetExport = input.exportName ?? "default";
    const fn = configs.find(c => c.exportName === targetExport) ?? configs[0]!;
    const config = fn.config;
    const handlerName = fn.exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName
    };

    yield* Effect.logDebug(`Deploying API handler ${handlerName} to ${input.region}`);

    const { layerArn, external } = yield* ensureLayerAndExternal({
      project: input.project,
      stage: tagCtx.stage,
      region: input.region,
      projectDir: input.projectDir
    });

    const { functionArn } = yield* deployApiFunction({
      input,
      fn,
      ...(layerArn ? { layerArn } : {}),
      ...(external.length > 0 ? { external } : {})
    });

    // Setup API Gateway with two routes for basePath
    yield* Effect.logDebug("Setting up API Gateway...");
    const { apiId } = yield* ensureProjectApi({
      projectName: input.project,
      stage: tagCtx.stage,
      region: input.region,
      tags: makeTags(tagCtx, "api-gateway")
    });

    // Route 1: ANY /basePath — catches POST to base path
    yield* addRouteToApi({
      apiId,
      region: input.region,
      functionArn,
      method: "ANY",
      path: config.basePath
    });

    // Route 2: ANY /basePath/{proxy+} — catches GET sub-paths
    const { apiUrl } = yield* addRouteToApi({
      apiId,
      region: input.region,
      functionArn,
      method: "ANY",
      path: `${config.basePath}/{proxy+}`
    });

    yield* Effect.logDebug(`Deployment complete! URL: ${apiUrl}`);

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
