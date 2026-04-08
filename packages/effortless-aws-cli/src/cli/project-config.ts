import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import type { EffortlessConfig, ProjectManifest } from "effortless-aws";
import { loadConfig } from "./config";

export type ProjectContext =
  | { mode: "legacy"; config: EffortlessConfig | null; projectDir: string }
  | { mode: "project"; manifest: ProjectManifest; projectDir: string };

export class ProjectConfig extends Context.Tag("ProjectConfig")<ProjectConfig, ProjectContext>() {
  static Live = Layer.effect(
    ProjectConfig,
    Effect.gen(function* () {
      const loaded = yield* loadConfig();
      if (loaded.mode === "project") {
        return { mode: "project", manifest: loaded.manifest, projectDir: loaded.configDir };
      }
      return { mode: "legacy", config: loaded.config, projectDir: loaded.configDir };
    })
  );
}
