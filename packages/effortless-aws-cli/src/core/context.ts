import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { EffortlessConfig } from "effortless-aws";

// ============ DeployContext ============

type DeployContextShape = {
  project: string;
  stage: string;
  region: string;
};

export class DeployContext extends Context.Tag("DeployContext")<DeployContext, DeployContextShape>() {}

export const makeDeployContext = (shape: DeployContextShape) =>
  Layer.succeed(DeployContext, shape);

// ============ CliContext ============

export type CliContextShape = {
  project: string;
  stage: string;
  region: string;
  config: EffortlessConfig | null;
  projectDir: string;
  patterns: string[] | null;
};

export class CliContext extends Context.Tag("CliContext")<CliContext, CliContextShape>() {}

export class MissingProjectError {
  readonly _tag = "MissingProjectError";
}

// ============ ProjectConfig ============

export type ProjectConfigShape = {
  config: EffortlessConfig | null;
  projectDir: string;
};

export class ProjectConfig extends Context.Tag("ProjectConfig")<ProjectConfig, ProjectConfigShape>() {}
