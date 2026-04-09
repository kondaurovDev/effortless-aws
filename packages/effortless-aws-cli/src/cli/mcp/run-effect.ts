import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { NodeContext } from "@effect/platform-node";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CliContext, makeCliContext } from "~/cli/cli-context";
import { ProjectConfigLive } from "~/cli/project-config";
import { DEFAULT_STAGE, DEFAULT_REGION } from "~/cli/config";
import { DeployContext } from "~/core";
import { Esbuild } from "~/build/esbuild";

/**
 * Build the full Effect layer stack for MCP tool execution.
 * Mirrors withCliContext() but without CLI arg parsing.
 */
export const makeContext = (
  makeClients?: (region: string) => Layer.Layer<any>,
) => {
  const cliContextLayer = makeCliContext({
    project: Option.none(),
    stage: DEFAULT_STAGE,
    region: DEFAULT_REGION,
  });

  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> => {
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
      Logger.withMinimumLogLevel(LogLevel.None),
      Effect.provide(cliContextLayer),
      Effect.provide(configLayer),
      Effect.provide(NodeContext.layer),
    ) as Effect.Effect<A, E, never>;
  };
};

/** Run a fully-provided Effect and return an MCP CallToolResult. */
export const runToolEffect = async <A>(
  effect: Effect.Effect<A, unknown, never>,
): Promise<CallToolResult> => {
  try {
    const result = await Effect.runPromise(effect);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ error: message }),
      }],
      isError: true,
    };
  }
};
