import { Effect } from "effect";
import { execSync } from "child_process";
import type { ExtractedSiteFunction } from "~/build/bundle";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

// ============ Site handler deployment ============

type DeploySiteLambdaInput = {
  input: DeployInput;
  fn: ExtractedSiteFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
};

/** @internal */
export const deploySiteLambda = ({ input, fn, layerArn, external, depsEnv, depsPermissions }: DeploySiteLambdaInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = config.name ?? exportName;

    // Run build command if specified
    if (config.build) {
      yield* Effect.logInfo(`Building site: ${config.build}`);
      yield* Effect.try({
        try: () => execSync(config.build!, { cwd: input.projectDir, stdio: "inherit" }),
        catch: (error) => new Error(`Site build failed: ${error}`),
      });
    }

    // Auto-generate static file globs from the dir property
    const staticGlobs = [`${config.dir}/**/*`];

    const { functionArn } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "site",
      ...(config.memory ? { memory: config.memory } : {}),
      timeout: config.timeout ?? 5,
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      staticGlobs,
    });

    return { exportName, functionArn, config, handlerName };
  });
