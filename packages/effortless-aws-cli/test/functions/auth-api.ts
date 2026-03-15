import { defineApi, defineAuth, defineStaticSite } from "effortless-aws";

type UserSession = { userId: string; role: "admin" | "user" };

const auth = defineAuth<UserSession>({
  loginPath: "/login",
  public: ["/login", "/assets/*"],
  expiresIn: "7d",
});

export const api = defineApi({
  basePath: "/api",
  auth,
  get: {
    "/me": async ({ auth }) => ({
      status: 200,
      body: { session: auth.session },
    }),
  },
  post: async ({ req, auth }) => {
    if (req.path === "/login") {
      return auth.createSession({ userId: "u123", role: "admin" });
    }
    return auth.clearSession();
  },
});

export const site = defineStaticSite({
  build: "pnpm build",
  dir: "dist",
  spa: true,
  auth,
  routes: { "/api/*": api },
});
