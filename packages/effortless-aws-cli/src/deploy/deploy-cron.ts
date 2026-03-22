import { Effect } from "effect";
import type { ExtractedCronFunction } from "~/build/bundle";
import { toSeconds } from "effortless-aws";
import {
  ensureSchedule,
  ensureSchedulerRole,
  makeTags,
  resolveStage,
  type TagContext,
} from "../aws";
import {
  type DeployInput,
  deployCoreLambda,
} from "./shared";

export type DeployCronResult = {
  exportName: string;
  functionArn: string;
  status: import("~/aws/lambda").LambdaStatus;
  bundleSize?: number;
  scheduleArn: string;
  schedule: string;
  timezone?: string;
};

type DeployCronFunctionInput = {
  input: DeployInput;
  fn: ExtractedCronFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const CRON_DEFAULT_PERMISSIONS = ["logs:*"] as const;

/** @internal */
export const deployCronFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployCronFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName,
    };

    // Deploy Lambda
    const { functionArn, status, bundleSize } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: CRON_DEFAULT_PERMISSIONS,
      bundleType: "cron",
      ...(config.lambda?.permissions ? { permissions: config.lambda.permissions } : {}),
      ...(config.lambda?.memory ? { memory: config.lambda.memory } : {}),
      ...(config.lambda?.timeout ? { timeout: toSeconds(config.lambda.timeout) } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      ...(depsEnv ? { depsEnv } : {}),
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {}),
    });

    // Create scheduler IAM role (Scheduler → Lambda invoke)
    yield* Effect.logDebug("Creating scheduler IAM role...");
    const schedulerRoleArn = yield* ensureSchedulerRole(
      input.project,
      tagCtx.stage,
      handlerName,
      functionArn,
      makeTags(tagCtx, "iam-role"),
    );

    // Create/update EventBridge Scheduler schedule
    yield* Effect.logDebug("Creating EventBridge schedule...");
    const scheduleName = `${input.project}-${tagCtx.stage}-${handlerName}`;
    const { scheduleArn } = yield* ensureSchedule({
      name: scheduleName,
      schedule: config.schedule,
      ...(config.timezone ? { timezone: config.timezone } : {}),
      targetArn: functionArn,
      roleArn: schedulerRoleArn,
      tags: makeTags(tagCtx, "scheduler"),
    });

    yield* Effect.logDebug(`Cron deployment complete! Schedule: ${scheduleName}`);

    return {
      exportName,
      functionArn,
      status,
      bundleSize,
      scheduleArn,
      schedule: config.schedule,
      ...(config.timezone ? { timezone: config.timezone } : {}),
    };
  });
