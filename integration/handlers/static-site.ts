import { defineApi, defineBucket, defineStaticSite } from "effortless-aws";

// ── API backend (proxied via CloudFront /api/*) ────────────────

export const siteApi = defineApi({ basePath: "/api" })
  .config(({ defineSecret }) => ({
    authSecret: defineSecret({ key: "integration-test/auth-secret" }),
  }))
  .setup(({ config, enableAuth }) => ({
    auth: enableAuth<{ userId: string }>({
      secret: config.authSecret,
      expiresIn: "1h",
    }),
  }))
  .get("/health", async ({ ok }) => ok({ status: "ok" }), { public: true })
  .get("/echo", async ({ req, ok }) =>
    ok({ query: req.query }),
    { public: true },
  )
  // Login: creates session + CloudFront signed cookies for /files/*
  .post("/login", async ({ input, auth }) => {
    const { userId } = input as { userId: string };
    return auth.createSession({ userId }, {
      cdnPolicy: { path: "/files/*", ttl: "1h" },
    });
  }, { public: true })
  .get("/me", async ({ auth, ok }) => ok({ session: auth.session }));

// ── Private file storage (served via CloudFront signed cookies) ─

export const storage = defineBucket().build();

// ── Static site with SPA + API + private bucket routing ─────────

export const site = defineStaticSite()({
  dir: "site",
  spa: true,
  routes: {
    "/api/*": siteApi,
    "/files/*": { bucket: storage, access: "private" },
  },
});
