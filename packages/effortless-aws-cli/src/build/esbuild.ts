import * as esbuild from "esbuild";
import { Context, Effect, Layer } from "effect";

export class EsbuildError {
  readonly _tag = "EsbuildError";
  constructor(readonly cause: unknown) {}
}

export interface EsbuildService {
  readonly build: (options: esbuild.BuildOptions) => Effect.Effect<esbuild.BuildResult, EsbuildError>;
}

export class Esbuild extends Context.Tag("Esbuild")<Esbuild, EsbuildService>() {
  static Default = Layer.succeed(Esbuild, {
    build: (options) =>
      Effect.tryPromise({
        try: () => esbuild.build(options),
        catch: (error) => new EsbuildError(error),
      }),
  });
}

export const esbuildBuild = (options: esbuild.BuildOptions) =>
  Effect.flatMap(Esbuild, (svc) => svc.build(options));

/**
 * Bundle TypeScript/JS with esbuild and evaluate via data: URL import.
 * No temp files — uses base64 data URL for dynamic import.
 */
export const esbuildEval = <T = unknown>(options: esbuild.BuildOptions) =>
  Effect.gen(function* () {
    const result = yield* esbuildBuild({
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      ...options,
    });

    const code = result.outputFiles?.[0]?.text;
    if (!code) {
      return yield* Effect.fail(new EsbuildError("esbuild produced no output"));
    }

    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const mod = yield* Effect.tryPromise({
      try: () => import(dataUrl),
      catch: (error) => new EsbuildError(error),
    });

    return mod as T;
  });
