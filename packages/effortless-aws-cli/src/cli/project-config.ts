import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import type { EffortlessConfig } from "effortless-aws";
import { loadConfig } from "./config";

export type ProjectContext = {
  config: EffortlessConfig | null;
  projectDir: string;
};

export class ProjectConfig extends Context.Tag("ProjectConfig")<ProjectConfig, ProjectContext>() {
  static Live = Layer.effect(
    ProjectConfig,
    Effect.gen(function* () {
      const { config, configDir } = yield* loadConfig();
      return { config, projectDir: configDir };
    })
  );
}
