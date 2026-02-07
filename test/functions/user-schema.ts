import { defineHttp } from "../../src/handlers/define-http";
import { Effect, pipe } from "effect";
import * as S from "effect/Schema";

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

export default defineHttp({
  name: "effect-schema-test",
  method: "POST",
  path: "/user",
  onRequest: async ({ req }) => {
    const result = processUser(req.body);
    return {
      status: 200,
      body: result
    };
  }
});
