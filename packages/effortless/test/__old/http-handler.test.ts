import { describe, it, expect, vi } from "vitest"
import { Effect, Layer, pipe } from "effect"
import * as S from "effect/Schema"

import { HttpRequest } from "../../src/__handlers/models/http-request";
import { ApiGatewayProxyEventV2, createLambdaHandler } from "../../src/__handlers/http-handler";

const handleFn = vi.fn<(_: HttpRequest) => Effect.Effect<unknown, unknown, never>>()

const httpHandler =
  createLambdaHandler({
    layer: Layer.empty,
    handle: handleFn
  })


describe("http handler, success", () => {

  it("should return successful response", async () => {

    handleFn.mockImplementationOnce(
      request =>
        pipe(
          request.BodySchema(S.Struct({ name: S.String })),
          Effect.andThen(body => `hey ${body.name}`)
        )
    )

    const res =
      httpHandler(
        ApiGatewayProxyEventV2({
          queryStringParameters: { case: "success", requestId: "1234567" },
          body: `{"name": "test25"}`,
          headers: {
            "content-type": "application/json"
          },
          requestContext: {
            authorizer: {
              lambda: {
                param1: "secret"
              }
            }
          },
          rawPath: "/asd"
        })
      );

    await expect(res.then(_ => _.body)).resolves.toEqual("\"hey test25\"");

    await expect(res.then(_ => _.statusCode)).resolves.toEqual(200);

  });

  it("should fail", async () => {

    handleFn.mockImplementationOnce(
      () => Effect.fail("Some internal error")
    )

    const res =
      httpHandler(
        ApiGatewayProxyEventV2({
          queryStringParameters: { case: "die" },
          rawPath: "/"
        })
      );

    await expect(res.then(_ => _.body)).resolves.toEqual("\"Unknown exception was thrown\"");
    await expect(res.then(_ => _.statusCode)).resolves.toEqual(400);

  });

})

describe("http handler", () => {

  it("urlencoded should work", async () => {

    handleFn.mockImplementationOnce(
      request =>
        pipe(
          request.BodySchema(S.Object)
        )
    )

    const res =
      httpHandler(
        ApiGatewayProxyEventV2({
          body: `YWN0aW9uPWF1ZGlvJmZpbGU9c29tZVRleHQ`,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          isBase64Encoded: true,
          rawPath: "/somePath"
        })
      );

    await expect(res.then(_ => _.body)).resolves.toEqual(
      JSON.stringify({
        action: "audio",
        file: "someText"
      })
    );

    await expect(res.then(_ => _.statusCode)).resolves.toEqual(200);

  });

})
