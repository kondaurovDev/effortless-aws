import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import { Console } from "effect";

import { ProjectConfig, ProjectConfigLive } from "./project-config";
import { getPatternsFromConfig } from "./config";
import { CliContext, MissingProjectError, DeployContext } from "../core";
import { Esbuild } from "../build/esbuild";

// Re-export for consumers
export { CliContext, MissingProjectError } from "../core";
export type { CliContextShape } from "../core";

export const makeCliContext = (opts: {
  project: Option.Option<string>;
  stage: string;
  region: string;
}) =>
  Layer.effect(
    CliContext,
    Effect.gen(function* () {
      const { config, projectDir } = yield* ProjectConfig;
      const project = Option.getOrElse(opts.project, () => config?.name ?? "");
      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return yield* Effect.fail(new MissingProjectError());
      }
      const stage = config?.stage ?? opts.stage;
      const region = config?.region ?? opts.region;
      const patterns = getPatternsFromConfig(config);
      return { project, stage, region, config, projectDir, patterns };
    })
  );

/**
 * Composes ProjectConfig → CliContext → AWS clients → logger into a single pipeline.
 * Provides CliContext, DeployContext, AWS clients (resolved from region), and log level.
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
    const deployLayer = Layer.succeed(DeployContext, {
      project: ctx.project,
      stage: ctx.stage,
      region: ctx.region,
    });
    const withDeploy = Effect.provide(effect, deployLayer);
    const withProvided = makeClients
      ? (withDeploy as Effect.Effect<A, E, any>).pipe(Effect.provide(makeClients(ctx.region)))
      : withDeploy;
    return yield* withProvided as Effect.Effect<A, E, CliContext>;
  });

  const configLayer = ProjectConfigLive.pipe(Layer.provide(Esbuild.Default));

  return program.pipe(
    Logger.withMinimumLogLevel(logLevel),
    Effect.provide(makeCliContext(opts)),
    Effect.provide(configLayer),
  ) as Effect.Effect<A, E | MissingProjectError, never>;
};
