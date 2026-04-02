import { defineApi } from "effortless-aws";

export const testApi = defineApi({ basePath: "/test" })
  // Basic GET
  .get("/", async ({ ok }) => ok({ status: "ok" }))

  // Path parameters
  .get("/users/{id}", async ({ req, ok }) =>
    ok({ id: req.params.id }),
  )

  // Multiple path params
  .get("/orgs/{orgId}/members/{memberId}", async ({ req, ok }) =>
    ok({ orgId: req.params.orgId, memberId: req.params.memberId }),
  )

  // Query parameters
  .get("/search", async ({ req, ok }) =>
    ok({ q: req.query.q, page: req.query.page }),
  )

  // POST with JSON body
  .post("/echo", async ({ input, ok }) => ok(input))

  // PUT
  .put("/items/{id}", async ({ input, req, ok }) =>
    ok({ id: req.params.id, ...(input as object) }),
  )

  // DELETE
  .delete("/items/{id}", async ({ req, ok }) =>
    ok({ deleted: req.params.id }),
  )

  // Content types
  .get("/html", async () => ({
    status: 200,
    body: "<h1>Hello</h1>",
    contentType: "html" as const,
  }))

  .get("/text", async () => ({
    status: 200,
    body: "plain text",
    contentType: "text" as const,
  }))

  // Custom headers
  .get("/custom-headers", async () => ({
    status: 200,
    body: { ok: true },
    headers: { "X-Custom": "test-value" },
  }))

  // Status codes via ok/fail helpers
  .post("/validate", async ({ input, ok, fail }) => {
    const body = input as { name?: string };
    if (!body.name) return fail("name is required");
    return ok({ name: body.name }, 201);
  })

  // Error: unhandled throw -> 500
  .get("/error", async () => {
    throw new Error("intentional test error");
  })

  // Cache-Control: shorthand duration (public by default, swr = ttl * 2)
  .get("/cached", async ({ ok }) =>
    ok({ ts: Date.now() }),
    { cache: "30s" },
  )

  // Cache-Control: private scope (no s-maxage, no swr)
  .get("/cached-private", async ({ ok }) =>
    ok({ ts: Date.now() }),
    { cache: { ttl: "1m", scope: "private" } },
  )

  // Cache-Control: explicit swr
  .get("/cached-swr", async ({ ok }) =>
    ok({ ts: Date.now() }),
    { cache: { ttl: "10s", swr: "2m" } },
  )

  // Cache-Control: numeric seconds
  .get("/cached-num", async ({ ok }) =>
    ok({ ts: Date.now() }),
    { cache: 60 },
  )

  // Request echo: returns full request details for inspection
  .post("/inspect", async ({ req, ok }) =>
    ok({
      method: req.method,
      path: req.path,
      headers: req.headers,
      query: req.query,
      body: req.body,
    }),
  );
