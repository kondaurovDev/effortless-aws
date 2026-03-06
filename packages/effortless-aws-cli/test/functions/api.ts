import { defineApi, defineTable, param } from "effortless-aws";
import { Effect, pipe } from "effect";
import * as S from "effect/Schema";

// ── Shared table (used as dep) ───────────────────────────────

type Session = { sid: string; userId: string; expiresAt: number };

export const sessions = defineTable<Session>({});

// ── GET /hello (with params) ─────────────────────────────────

export const hello = defineApi({
  basePath: "/hello",
  config: {
    greeting: param("greeting-text"),
  },
  get: {
    "/": async ({ req, config }) => ({
      status: 200,
      body: { message: config.greeting, path: req.path }
    }),
  },
});

// ── POST /user (with schema + deps + params + context) ───────

const UserSchema = S.Struct({
  name: S.String,
  age: S.Number
});

const decodeUser = (input: unknown) =>
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

export const user = defineApi({
  basePath: "/user",
  deps: () => ({ sessions }),
  config: {
    maxAge: param("session-max-age", Number),
  },
  setup: ({ config }) => ({
    sessionTtl: config.maxAge * 60,
  }),
  schema: (input) => decodeUser(input),
  post: async ({ data, deps, config, ctx }) => {
    // deps.sessions is TableClient<Session>
    // config.maxAge is number
    // ctx.sessionTtl is number
    // data is { greeting: string; isAdult: boolean }
    void deps.sessions;
    void config.maxAge;
    void ctx.sessionTtl;
    return {
      status: 200,
      body: data
    };
  },
});
