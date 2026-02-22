import { Effect } from "effect";
import { execSync } from "child_process";
import type { ExtractedAppFunction } from "~/build/bundle";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

// ============ App handler deployment ============

type DeployAppLambdaInput = {
  input: DeployInput;
  fn: ExtractedAppFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
};

/** @internal */
export const deployAppLambda = ({ input, fn, layerArn, external, depsEnv, depsPermissions }: DeployAppLambdaInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;

    // Run build command if specified
    if (config.build) {
      yield* Effect.logDebug(`Building site: ${config.build}`);
      yield* Effect.try({
        try: () => execSync(config.build!, { cwd: input.projectDir, stdio: "inherit" }),
        catch: (error) => new Error(`Site build failed: ${error}`),
      });
    }

    // Auto-generate static file globs from the dir property
    const staticGlobs = [`${config.dir}/**/*`];

    const { functionArn, status } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "app",
      ...(config.memory ? { memory: config.memory } : {}),
      timeout: config.timeout ?? 5,
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      staticGlobs,
    });

    return { exportName, functionArn, status, config, handlerName };
  });
