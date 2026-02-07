import { defineHttp } from "../../src/handlers/define-http";
import { Effect, pipe } from "effect";
import * as S from "effect/Schema";

// GET /hello
export const hello = defineHttp({
  name: "api-hello",
  method: "GET",
  path: "/hello",
  onRequest: async ({ req }) => ({
    status: 200,
    body: { message: "Hello World!", path: req.path }
  })
});

// POST /user
const UserSchema = S.Struct({
  name: S.String,
  age: S.Number
});

const processUser = (input: unknown) =>
  pipe(
    S.decodeUnknown(UserSchema)(input),
    Effect.map(user => ({
      greeting: `Hello ${user.name}, you are ${user.age} years old!`,
      isAdult: user.age >= 18
    })),
    Effect.catchAll(() => Effect.succeed({
      greeting: "Invalid user data",
      isAdult: false
    })),
    Effect.runSync
  );

export const user = defineHttp({
  name: "api-user",
  method: "POST",
  path: "/user",
  onRequest: async ({ req }) => ({
    status: 200,
    body: processUser(req.body)
  })
});
