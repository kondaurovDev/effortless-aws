import * as S from "effect/Schema";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";

import { LogLevelConfigFromEnv } from "./internal/log-level";

export type AuthorizerOutput =
  typeof AuthorizerOutputSchema.Type

export const AuthorizerOutputSchema =
  S.Union(
    S.Struct({
      isAuthorized: S.Literal(true),
      context: S.optional(S.Record({ key: S.String, value: S.String }))
    }),
    S.Struct({
      isAuthorized: S.Literal(false)
    })
  );

export type AuthorizerInput =
  typeof AuthorizerInputSchema.Type;

// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html#http-api-lambda-authorizer.payload-format
export const AuthorizerInputSchema =
  S.Struct({
    identitySource: S.NullishOr(S.Array(S.String)),
    headers: S.Record({ key: S.String, value: S.String })
  });

type AuthorizerHandler<R> = {
  handle: (_: AuthorizerInput) => Effect.Effect<AuthorizerOutput, unknown, R>
  live: Layer.Layer<R, unknown, never>
}

export const createAuthorizerHandler = <R>(
  authorizerHandler: AuthorizerHandler<R>,
) =>
  pipe(
    ManagedRuntime.make(authorizerHandler.live),
    runtime =>
      (authorizerInput: AuthorizerInput) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("auth parameters", authorizerInput)
          return yield* authorizerHandler.handle(authorizerInput)
        }).pipe(
          Effect.catchAllCause((error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("auth error", error)
              return { isAuthorized: false as const }
            })
          ),
          Effect.provide(LogLevelConfigFromEnv),
          runtime.runPromise
        )
  )
