import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { ProjectConfig } from "../core";
import { loadConfig } from "./config";

// Re-export for consumers
export { ProjectConfig } from "../core";
export type { ProjectConfigShape } from "../core";

export const ProjectConfigLive = Layer.effect(
  ProjectConfig,
  Effect.gen(function* () {
    const { config, configDir } = yield* loadConfig();
    return { config, projectDir: configDir };
  })
);
