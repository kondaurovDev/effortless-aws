import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { LogLevelConfigFromEnv } from "./internal/log-level";

type RawHandlerResult<R = unknown> = {
  result?: R
  error?: string
  errorDetails?: unknown
}

export const createLambdaHandler = <I, O, E, R>(
  handler: {
    handle: (input: I) => Effect.Effect<O, E, R>
    layer: Layer.Layer<R, unknown, never>
  }
) =>
  pipe(
    ManagedRuntime.make(
      Layer.mergeAll(handler.layer, LogLevelConfigFromEnv)
    ),
    runtime =>
      (input: I): Promise<RawHandlerResult<O>> =>
        pipe(
          handler.handle(input),
          Effect.match({
            onSuccess: result => ({ result }),
            onFailure: error => ({
              error: (error as { _tag?: string })._tag ?? "UnknownError",
              errorDetails: error
            })
          }),
          runtime.runPromise
        )
  )
