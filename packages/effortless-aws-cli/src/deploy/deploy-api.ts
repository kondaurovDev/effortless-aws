import { Effect } from "effect";
import { toSeconds } from "effortless-aws";
import { extractConfigsFromFile, type ExtractedApiFunction } from "~/build/bundle";
import {
  Aws,
  ensureFunctionUrl,
  addFunctionUrlPublicAccess,
  makeTags,
  resolveStage,
  type TagContext
} from "../aws";
import {
  type DeployInput,
  type DeployResult,
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

    const { functionArn, status, bundleSize } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "api",
      ...(config.lambda?.permissions ? { permissions: config.lambda.permissions } : {}),
      ...(config.lambda?.memory ? { memory: config.lambda.memory } : {}),
      ...(config.lambda?.timeout ? { timeout: toSeconds(config.lambda.timeout) } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {})
    });

    return { exportName, functionArn, status, bundleSize, config, handlerName };
  });

export const deploy = (input: DeployInput) =>
  Effect.gen(function* () {
    const configs = yield* Effect.promise(() => extractConfigsFromFile<import("effortless-aws").ApiConfig>(input.file, input.projectDir, "api"));

    if (configs.length === 0) {
      return yield* Effect.fail(new Error("Could not extract defineApi config from source"));
    }

    const targetExport = input.exportName ?? "default";
    const fn = configs.find(c => c.exportName === targetExport) ?? configs[0]!;
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
      packageDir: input.packageDir ?? input.projectDir,
      extraNodeModules: input.extraNodeModules
    });

    const { functionArn } = yield* deployApiFunction({
      input,
      fn,
      ...(layerArn ? { layerArn } : {}),
      ...(external.length > 0 ? { external } : {})
    });

    // Setup Function URL
    const lambdaName = `${input.project}-${tagCtx.stage}-${handlerName}`;
    const { functionUrl } = yield* ensureFunctionUrl(lambdaName, fn.config.stream ? "RESPONSE_STREAM" : undefined);
    yield* addFunctionUrlPublicAccess(lambdaName);

    yield* Effect.logDebug(`Deployment complete! URL: ${functionUrl}`);

    return {
      exportName: fn.exportName,
      url: functionUrl,
      functionArn
    } satisfies DeployResult;
  }).pipe(
    Effect.provide(
      Aws.makeClients({
        lambda: { region: input.region },
        iam: { region: input.region }
      })
    )
  );
