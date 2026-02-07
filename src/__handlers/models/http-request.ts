import * as S from "effect/Schema"
import { Effect, Match, pipe } from "effect"

import { HttpHandlerError } from "~/__handlers/internal/errors"

export class HttpRequest
  extends S.Class<HttpRequest>("HttpRequest")({
    body: S.String.pipe(S.optional),
    headers: S.Record({ key: S.String, value: S.String }).pipe(S.optional),
    rawPath: S.NonEmptyString,
    queryStringParameters: S.Record({ key: S.String, value: S.String }).pipe(S.optional),
    isBase64Encoded: S.Boolean.pipe(S.optional),
    requestContext:
      S.Struct({
        http:
          S.Struct({
            method: S.String
          }),
        authorizer:
          S.Struct({
            lambda: S.NullOr(S.Record({ key: S.NonEmptyString, value: S.Unknown }))
          })
      }).pipe(S.partial, S.optional)
  }) {

  readonly BodySchema = <I>(
    schema: S.Schema<I>
  ) =>
    Effect.gen(this, function* () {
      const contentTypeArr = yield* this.ContentType
      const contentType = yield* Effect.fromNullable(contentTypeArr.at(0))
      const body = yield* this.DecodedBody

      const parsed = yield* pipe(
        Match.value(contentType),
        Match.when("application/x-www-form-urlencoded", () =>
          Effect.succeed(Object.fromEntries(new URLSearchParams(body).entries()))
        ),
        Match.when("application/json", () =>
          Effect.try(() => JSON.parse(body))
        ),
        Match.orElse(() =>
          Effect.fail(new HttpHandlerError({ code: "unsupported_content_type" }))
        )
      )

      return yield* S.decodeUnknown(schema)(parsed)
    })

  readonly DecodedBody =
    pipe(
      Match.value(this.body),
      Match.when(Match.undefined, () =>
        Effect.fail(new HttpHandlerError({ code: "undefined_body" }))
      ),
      Match.orElse(body =>
        this.isBase64Encoded === true ?
          Effect.succeed(Buffer.from(body, "base64").toString()) :
          Effect.succeed(body)
      )
    )

  readonly QueryParameter = <O>(
    parameterName: string,
    to: S.Schema<O, string>
  ) =>
    pipe(
      Effect.fromNullable(this.queryStringParameters?.[parameterName]),
      Effect.catchTag("NoSuchElementException", () =>
        Effect.fail(new HttpHandlerError({ code: "missing_required_query_parameter" }))
      ),
      Effect.andThen(S.decode(to))
    )

  readonly ContentType =
    pipe(
      Effect.fromNullable(this.headers?.['content-type']?.toLowerCase().split(";")),
      Effect.catchTag("NoSuchElementException", () =>
        Effect.fail(new HttpHandlerError({ code: "undefined_content_type" }))
      )
    )

}


export type HttpMediaPayload = {
  body: string,
  contentType: string[]
}
