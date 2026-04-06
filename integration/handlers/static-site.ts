import { defineApi, defineBucket, defineStaticSite } from "effortless-aws";

// ── API backend (proxied via CloudFront /api/*) ────────────────

export const siteApi = defineApi({ basePath: "/api" })
  .deps(() => ({ storage }))
  .config(({ defineSecret }) => ({
    authSecret: defineSecret({ key: "integration-test/auth-secret" }),
  }))
  .auth<{ userId: string }>(({ config }) => ({
    secret: config.authSecret,
    expiresIn: "1h",
  }))
  .setup(({ deps }) => ({ bucket: deps.storage }))
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
  .get({ path: "/me" }, async ({ auth, ok }) => ok({ session: auth.session }))
  // Bucket CRUD via API
  .post({ path: "/files", public: true }, async ({ input, bucket, ok }) => {
    const { key, content, contentType } = input as { key: string; content: string; contentType?: string };
    await bucket.put(key, content, contentType ? { contentType } : undefined);
    return ok({ uploaded: key }, 201);
  })
  .get({ path: "/files/list", public: true }, async ({ req, bucket, ok }) => {
    const items = await bucket.list(req.query.prefix);
    return ok({ items });
  })
  .get({ path: "/files/{key}", public: true }, async ({ req, bucket, ok, fail }) => {
    const result = await bucket.get(req.params.key!);
    if (!result) return fail("not found", 404);
    return ok({ content: result.body.toString("utf-8"), contentType: result.contentType });
  })
  .delete({ path: "/files/{key}", public: true }, async ({ req, bucket, ok }) => {
    await bucket.delete(req.params.key!);
    return ok({ deleted: req.params.key });
  });

// ── Private file storage (served via CloudFront signed cookies) ─

export const storage = defineBucket({ seed: "../fixtures/storage" }).build();

// ── Public file storage (served without auth) ────────────────────

export const publicFiles = defineBucket({ seed: "../fixtures/public" }).build();

// ── Static site with SPA + API + private/public bucket routing ───

export const site = defineStaticSite({ dir: "site", errorPage: "index.html" })
  .route("/api/*", siteApi)
  .route("/files/*", storage, { access: "private" })
  .route("/public/*", publicFiles, { access: "public" })
  .build();
