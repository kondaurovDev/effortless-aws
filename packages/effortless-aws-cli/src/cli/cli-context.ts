import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import { Console } from "effect";
import type { EffortlessConfig, ProjectManifest } from "effortless-aws";

import { ProjectConfig } from "./project-config";
import { getPatternsFromConfig } from "./config";

export type CliContextShape = {
  project: string;
  stage: string;
  region: string;
  config: EffortlessConfig | null;
  projectDir: string;
  patterns: string[] | null;
  /** Set when effortless.config.ts uses defineProject() */
  manifest: ProjectManifest | null;
};

export class CliContext extends Context.Tag("CliContext")<CliContext, CliContextShape>() {}

export class MissingProjectError {
  readonly _tag = "MissingProjectError";
}

export const makeCliContext = (opts: {
  project: Option.Option<string>;
  stage: string;
  region: string;
}) =>
  Layer.effect(
    CliContext,
    Effect.gen(function* () {
      const projectCtx = yield* ProjectConfig;

      if (projectCtx.mode === "project") {
        const { manifest, projectDir } = projectCtx;
        const project = Option.getOrElse(opts.project, () => manifest.name);
        const stage = manifest.stage ?? opts.stage;
        const region = manifest.region ?? opts.region;
        return { project, stage, region, config: null, projectDir, patterns: null, manifest };
      }

      const { config, projectDir } = projectCtx;
      const project = Option.getOrElse(opts.project, () => config?.name ?? "");
      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return yield* Effect.fail(new MissingProjectError());
      }
      const stage = config?.stage ?? opts.stage;
      const region = config?.region ?? opts.region;
      const patterns = getPatternsFromConfig(config);
      return { project, stage, region, config, projectDir, patterns, manifest: null };
    })
  );

/**
 * Composes ProjectConfig → CliContext → AWS clients → logger into a single pipeline.
 * Provides CliContext, AWS clients (resolved from region), and log level.
 */
export const withCliContext = (
  opts: { project: Option.Option<string>; stage: string; region: string; verbose: boolean },
  makeClients?: (region: string) => Layer.Layer<any>,
) => <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MissingProjectError, never> => {
  const logLevel = opts.verbose ? LogLevel.Debug : LogLevel.Warning;

  const program = Effect.gen(function* () {
    const ctx = yield* CliContext;
    const withProvided = makeClients
      ? (effect as Effect.Effect<A, E, any>).pipe(Effect.provide(makeClients(ctx.region)))
      : effect;
    return yield* withProvided as Effect.Effect<A, E, CliContext>;
  });

  return program.pipe(
    Logger.withMinimumLogLevel(logLevel),
    Effect.provide(makeCliContext(opts)),
    Effect.provide(ProjectConfig.Live),
  ) as Effect.Effect<A, E | MissingProjectError, never>;
};
