import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { Path } from "@effect/platform";
import type { EffortlessConfig } from "effortless-aws";
import { loadConfig } from "./config";

export type ProjectContext = {
  config: EffortlessConfig | null;
  /** Directory where effortless.config.ts lives (= cwd) */
  cwd: string;
  /** Resolved project root (= cwd + root option). Used for handler file resolution. */
  projectDir: string;
};

export class ProjectConfig extends Context.Tag("ProjectConfig")<ProjectConfig, ProjectContext>() {
  static Live = Layer.effect(
    ProjectConfig,
    Effect.gen(function* () {
      const p = yield* Path.Path;
      const config = yield* loadConfig();
      const cwd = process.cwd();
      const projectDir = config?.root
        ? p.resolve(cwd, config.root)
        : cwd;
      return { config, cwd, projectDir };
    })
  );
}
