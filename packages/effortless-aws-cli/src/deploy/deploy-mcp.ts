import { Effect } from "effect";
import { toSeconds } from "effortless-aws";
import type { ExtractedMcpFunction } from "~/build/bundle";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

// ============ MCP handler deployment ============

type DeployMcpFunctionInput = {
  input: DeployInput;
  fn: ExtractedMcpFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

/** @internal */
export const deployMcpFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployMcpFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;

    const { functionArn, status, bundleSize } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      bundleType: "mcp",
      ...(config.lambda?.permissions ? { permissions: config.lambda.permissions } : {}),
      ...(config.lambda?.memory ? { memory: config.lambda.memory } : {}),
      ...(config.lambda?.timeout ? { timeout: toSeconds(config.lambda.timeout) } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {}),
    });

    return { exportName, functionArn, status, bundleSize, handlerName };
  });
