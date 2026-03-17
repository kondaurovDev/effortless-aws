import { defineApi, defineStaticSite, defineTable, defineSecret } from "effortless-aws";
import type { Effect } from "effect";
import * as S from "effect/Schema";

const LoginSchema = S.Struct({
  userId: S.String,
  role: S.Literal("admin", "user"),
});

type ApiKey = { pk: string; sk: string; role: "admin" | "user" };
type Session = { userId: string; role: "admin" | "user" };

export const apiKeys = defineTable<ApiKey>()({});

// --- Case 1: simple setup return ---

export const api = defineApi()({
  basePath: "/api",
  deps: () => ({ apiKeys }),
  config: ({ defineSecret }) => ({ appName: defineSecret(), sessionSecret: defineSecret() }),
  setup: ({ deps, config, enableAuth }) => ({
    appName: config.appName,
    auth: enableAuth<Session>({
      secret: config.sessionSecret,
      expiresIn: "7d",
      apiToken: {
        header: "x-api-key",
        verify: async (value: string) => {
          const items = await deps.apiKeys.query({ pk: value });
          const key = items[0];
          if (!key) return null;
          return { userId: key.sk, role: key.data.role };
        },
        cacheTtl: "5m",
      },
    }),
  }),
  routes: [
    {
      path: "GET /me",
      onRequest: async ({ appName, auth }) => ({
        status: 200,
        body: { session: auth.session, app: appName },
      }),
    },
    {
      path: "POST /login",
      public: true,
      onRequest: async ({ input, auth }) => {
        const data = S.decodeUnknownSync(LoginSchema)(input);
        return auth.createSession({ userId: data.userId, role: data.role });
      },
    },
    {
      path: "POST /logout",
      onRequest: async ({ auth }) => auth.clearSession(),
    },
  ],
});

// --- Case 2: complex setup with generic method (family-budget pattern) ---

type TableData =
  | { readonly tag: "expense"; readonly what: string; readonly price: number; readonly userId: string }
  | { readonly tag: "invoke-config"; readonly spreadsheet_id: string; readonly chat_id: string }
  | { readonly tag: "user"; readonly name: string; readonly token: string; readonly password: string };

export const table = defineTable<TableData>()({});

export const api2 = defineApi()({
  basePath: "/api",
  deps: () => ({ table }),
  config: ({ defineSecret }) => ({
    tgToken: defineSecret(),
    openaiToken: defineSecret(),
    adminPassword: defineSecret(),
    sessionSecret: defineSecret(),
  }),
  setup: ({ deps, config, enableAuth }) => ({
    table: deps.table,
    adminPassword: config.adminPassword,
    run: <A, E>(effect: Effect.Effect<A, E>) =>
      Promise.resolve(effect).then((body) => ({ status: 200 as const, body })),
    auth: enableAuth<{ userId: string }>({
      secret: config.sessionSecret,
      expiresIn: "7d",
      apiToken: {
        verify: async (value: string) => {
          const items = await deps.table.query({ pk: "user" });
          const user = items.find((i) => i.data.tag === "user" && i.data.token === value);
          if (!user) return null;
          return { userId: user.sk };
        },
      },
    }),
  }),
  routes: [
    {
      path: "GET /check",
      onRequest: ({ input, run }) => {
        void input;
        return run({} as Effect.Effect<{ ok: boolean }, never>);
      },
    },
    {
      path: "POST /login",
      public: true,
      onRequest: async ({ input, adminPassword, auth }) => {
        void input;
        if (adminPassword === "test") {
          return auth.createSession({ userId: "admin" });
        }
        return auth.createSession({ userId: "user" });
      },
    },
    {
      path: "POST /logout",
      onRequest: ({ auth }) => auth.clearSession(),
    },
  ],
});

export const site = defineStaticSite()({
  build: "pnpm build",
  dir: "dist",
  spa: true,
  routes: { "/api/*": api },
});
