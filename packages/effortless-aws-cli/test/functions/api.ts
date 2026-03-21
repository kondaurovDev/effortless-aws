import { defineApi, defineTable } from "effortless-aws";
import { Effect, pipe } from "effect";
import * as S from "effect/Schema";

// ── Shared table (used as dep) ───────────────────────────────

type Session = { sid: string; userId: string; expiresAt: number };

export const sessions = defineTable<Session>().build();

// ── GET /hello (with params via setup) ───────────────────────

export const hello = defineApi({ basePath: "/hello" })
  .config(({ defineSecret }) => ({
    greeting: defineSecret({ key: "greeting-text" }),
  }))
  .setup(({ config }) => ({ greeting: config.greeting }))
  .get("/", async ({ req, greeting }) => ({
    status: 200,
    body: { message: greeting, path: req.path },
  }));

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

export const user = defineApi({ basePath: "/user" })
  .deps(() => ({ sessions }))
  .config(({ defineSecret }) => ({
    maxAge: defineSecret<number>({ key: "session-max-age", transform: Number }),
  }))
  .setup(({ deps, config }) => ({
    sessions: deps.sessions,
    maxAge: config.maxAge,
    sessionTtl: config.maxAge * 60,
  }))
  .post("/create", async ({ input, sessions, maxAge, sessionTtl }) => {
    const data = decodeUser(input);
    void sessions;
    void maxAge;
    void sessionTtl;
    return {
      status: 200,
      body: data,
    };
  });
