import { defineApi } from "effortless-aws";
import { z } from "zod/v4";
import { db } from "./table";

// ── Session type ───────────────────────────────────────────────

type Session = { userId: string };

// ── API with deps + config + auth ──────────────────────────────

export const api = defineApi({ basePath: "/api" })
  .deps(() => ({ db }))
  .config(({ defineSecret }) => ({
    authSecret: defineSecret({ key: "integration-test/auth-secret" }),
  }))
  .setup(({ deps, config, enableAuth }) => ({
    notes: deps.db,
    auth: enableAuth<Session>({
      secret: config.authSecret,
      expiresIn: "1h",
      apiToken: {
        header: "x-api-key",
        verify: async (value: string) => {
          if (value === "test-api-token-42") return { userId: "api-token-user" };
          return null;
        },
        cacheTtl: "5m",
      },
    }),
  }))

  // Health: proves setup ran, deps resolved, config loaded
  .get({ path: "/health", public: true }, async ({ notes, ok }) =>
    ok({ status: "ok", hasTable: !!notes }),
  )

  // Auth: login (public)
  .post({
    path: "/login",
    input: z.object({ userId: z.string() }),
    public: true,
  }, async ({ input, auth }) => {
    return auth.createSession({ userId: input.userId });
  })

  // Auth: get current session (requires auth)
  .get({ path: "/me" }, async ({ auth, ok }) =>
    ok({ session: auth.session }),
  )

  // Auth: logout (requires auth)
  .post({ path: "/logout" }, async ({ auth }) =>
    auth.clearSession(),
  )

  // Table CRUD: create note (public for easy testing)
  .post({
    path: "/notes",
    input: z.object({ pk: z.string(), sk: z.string(), title: z.string(), content: z.string() }),
    public: true,
  }, async ({ input, notes, ok }) => {
    await notes.put({ pk: input.pk, sk: input.sk, data: { tag: "note" as const, title: input.title, content: input.content } });
    return ok({ created: true }, 201);
  })

  // Table CRUD: get note by pk + sk
  .get({ path: "/notes/{pk}/{sk}", public: true }, async ({ req, notes, ok, fail }) => {
    const item = await notes.get({ pk: req.params.pk!, sk: req.params.sk! });
    if (!item) return fail("not found", 404);
    return ok(item);
  })

  // Table CRUD: list notes by pk
  .get({ path: "/notes/{pk}", public: true }, async ({ req, notes, ok }) => {
    const items = await notes.query({ pk: req.params.pk! });
    return ok({ items });
  })

  // Table CRUD: delete note
  .delete({ path: "/notes/{pk}/{sk}", public: true }, async ({ req, notes, ok }) => {
    await notes.delete({ pk: req.params.pk!, sk: req.params.sk! });
    return ok({ deleted: true });
  })

  // Audit log: query stream events by note pk (same table, sk prefix)
  .get({ path: "/audit/{pk}", public: true }, async ({ req, notes, ok }) => {
    const items = await notes.query({ pk: req.params.pk!, sk: { begins_with: "audit#" } });
    return ok({ items });
  });
