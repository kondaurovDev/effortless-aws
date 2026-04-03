import { defineApi } from "effortless-aws";

export const testApi = defineApi({ basePath: "/test" })
  // Basic GET
  .get({ path: "/" }, async ({ ok }) => ok({ status: "ok" }))

  // Path parameters
  .get({ path: "/users/{id}" }, async ({ req, ok }) =>
    ok({ id: req.params.id }),
  )

  // Multiple path params
  .get({ path: "/orgs/{orgId}/members/{memberId}" }, async ({ req, ok }) =>
    ok({ orgId: req.params.orgId, memberId: req.params.memberId }),
  )

  // Query parameters
  .get({ path: "/search" }, async ({ req, ok }) =>
    ok({ q: req.query.q, page: req.query.page }),
  )

  // POST with JSON body
  .post({ path: "/echo" }, async ({ input, ok }) => ok(input))

  // PUT
  .put({ path: "/items/{id}" }, async ({ input, req, ok }) =>
    ok({ id: req.params.id, ...(input as object) }),
  )

  // DELETE
  .delete({ path: "/items/{id}" }, async ({ req, ok }) =>
    ok({ deleted: req.params.id }),
  )

  // Content types
  .get({ path: "/html" }, async () => ({
    status: 200,
    body: "<h1>Hello</h1>",
    contentType: "html" as const,
  }))

  .get({ path: "/text" }, async () => ({
    status: 200,
    body: "plain text",
    contentType: "text" as const,
  }))

  // Custom headers
  .get({ path: "/custom-headers" }, async () => ({
    status: 200,
    body: { ok: true },
    headers: { "X-Custom": "test-value" },
  }))

  // Status codes via ok/fail helpers
  .post({ path: "/validate" }, async ({ input, ok, fail }) => {
    const body = input as { name?: string };
    if (!body.name) return fail("name is required");
    return ok({ name: body.name }, 201);
  })

  // Error: unhandled throw -> 500
  .get({ path: "/error" }, async () => {
    throw new Error("intentional test error");
  })

  // Cache-Control: shorthand duration (public by default, swr = ttl * 2)
  .get({ path: "/cached", cache: "30s" }, async ({ ok }) =>
    ok({ ts: Date.now() }),
  )

  // Cache-Control: private scope (no s-maxage, no swr)
  .get({ path: "/cached-private", cache: { ttl: "1m", scope: "private" } }, async ({ ok }) =>
    ok({ ts: Date.now() }),
  )

  // Cache-Control: explicit swr
  .get({ path: "/cached-swr", cache: { ttl: "10s", swr: "2m" } }, async ({ ok }) =>
    ok({ ts: Date.now() }),
  )

  // Cache-Control: numeric seconds
  .get({ path: "/cached-num", cache: 60 }, async ({ ok }) =>
    ok({ ts: Date.now() }),
  )

  // Request echo: returns full request details for inspection
  .post({ path: "/inspect" }, async ({ req, ok }) =>
    ok({
      method: req.method,
      path: req.path,
      headers: req.headers,
      query: req.query,
      body: req.body,
    }),
  );
