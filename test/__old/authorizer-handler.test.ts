import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect";

import { createAuthorizerHandler } from "../../src/__handlers/authorizer-handler";

describe("authorizer ", () => {

  it("simple case", async () => {

    const handler =
      createAuthorizerHandler({
        live: Layer.empty,
        handle: (input) =>
          input.identitySource?.at(0) == "superSecret" ?
            Effect.succeed({
              isAuthorized: true
            }) : Effect.succeed({
              isAuthorized: false
            })
      });

    const result =
      await handler({
        headers: {},
        identitySource: [
          "superSecret"
        ]
      });

    expect(result.isAuthorized).toEqual(true);

  })

  it("error in handler", async () => {

    const handler =
      createAuthorizerHandler({
        handle: () =>
          Effect.fail("some error"),
        live: Layer.empty
      });

    const result =
      await handler({
        headers: {},
        identitySource: []
      });

    expect(result.isAuthorized).toEqual(false);

  })


})
