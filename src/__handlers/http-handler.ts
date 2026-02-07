import { Brand, Effect, Layer, ManagedRuntime } from "effect";
import * as S from "effect/Schema";
import type * as Lambda from "aws-lambda";
import type { PartialDeep } from "type-fest"

import { HttpRequest } from "./models/http-request";
import { mapToHttpResponse } from "./internal/mappers";

export type ApiGatewayProxyEventV2<AuthorizerContext = Record<string, unknown>> =
  PartialDeep<Lambda.APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>> & Brand.Brand<"ApiGatewayProxyEventV2">;

export const ApiGatewayProxyEventV2 =
  Brand.nominal<ApiGatewayProxyEventV2>();

export const createLambdaHandler = <R>(input: {
  handle: (_: HttpRequest) => Effect.Effect<unknown, unknown, R>
  layer: Layer.Layer<R>
}) => {
  const runtime = ManagedRuntime.make(input.layer)

  return (req: ApiGatewayProxyEventV2): Promise<Lambda.APIGatewayProxyStructuredResultV2> =>
    S.decodeUnknown(HttpRequest)(req).pipe(
      Effect.andThen(input.handle),
      Effect.either,
      Effect.andThen(mapToHttpResponse),
      Effect.catchAllDefect(() =>
        Effect.succeed({
          statusCode: 500,
          body: "Internal server error"
        })
      ),
      runtime.runPromise
    )
}
