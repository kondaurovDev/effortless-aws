import { defineApi, defineBucket, defineStaticSite } from "effortless-aws";

// ── API backend (proxied via CloudFront /api/*) ────────────────

export const siteApi = defineApi({ basePath: "/api" })
  .config(({ defineSecret }) => ({
    authSecret: defineSecret({ key: "integration-test/auth-secret" }),
  }))
  .auth<{ userId: string }>(({ config }) => ({
    secret: config.authSecret,
    expiresIn: "1h",
  }))
  .get({ path: "/health", public: true }, async ({ ok }) => ok({ status: "ok" }))
  .get({ path: "/echo", public: true }, async ({ req, ok }) =>
    ok({ query: req.query }),
  )
  // Login: creates session + CloudFront signed cookies for /files/*
  .post({ path: "/login", public: true }, async ({ input, auth }) => {
    const { userId } = input as { userId: string };
    return auth.createSession({ userId }, {
      cdnPolicy: { path: "/files/*", ttl: "1h" },
    });
  })
  .get({ path: "/me" }, async ({ auth, ok }) => ok({ session: auth.session }));

// ── Private file storage (served via CloudFront signed cookies) ─

export const storage = defineBucket({ seed: "../fixtures/storage" }).build();

// ── Static site with SPA + API + private bucket routing ─────────

export const site = defineStaticSite({ dir: "site", errorPage: "index.html" })
  .route("/api/*", siteApi)
  .route("/files/*", storage, { access: "private" })
  .build();
