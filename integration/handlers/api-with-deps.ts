import { defineApi, defineTable } from "effortless-aws";

// ── Single table: notes + audit events (discriminated by tag) ──

type NoteData = { tag: "note"; title: string; content: string };
type AuditData = { tag: "audit"; type: string; notePk: string; noteSk: string };
type Data = NoteData | AuditData;

export const notes = defineTable<Data>({
  streamView: "NEW_AND_OLD_IMAGES",
})
  .setup(({ table }) => ({ table }))
  .onRecord(async ({ record, table }) => {
    // Skip audit events to prevent infinite stream loop
    const data = record.new?.data ?? record.old?.data;
    if (data?.tag === "audit") return;

    await table.put({
      pk: record.keys.pk,
      sk: `audit#${record.eventName}#${record.keys.sk}#${Date.now()}`,
      data: { tag: "audit", type: record.eventName, notePk: record.keys.pk, noteSk: record.keys.sk },
    });
  });

// ── Session type ───────────────────────────────────────────────

type Session = { userId: string };

// ── API with deps + config + auth ──────────────────────────────

export const api = defineApi({ basePath: "/api" })
  .deps(() => ({ notes }))
  .config(({ defineSecret }) => ({
    authSecret: defineSecret({ key: "integration-test/auth-secret" }),
  }))
  .setup(({ deps, config, enableAuth }) => ({
    notes: deps.notes,
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
  .get("/health", async ({ notes, ok }) =>
    ok({ status: "ok", hasTable: !!notes }),
    { public: true },
  )

  // Auth: login (public)
  .post("/login", async ({ input, auth }) => {
    const { userId } = input as { userId: string };
    return auth.createSession({ userId });
  }, { public: true })

  // Auth: get current session (requires auth)
  .get("/me", async ({ auth, ok }) =>
    ok({ session: auth.session }),
  )

  // Auth: logout (requires auth)
  .post("/logout", async ({ auth }) =>
    auth.clearSession(),
  )

  // Table CRUD: create note (public for easy testing)
  .post("/notes", async ({ input, notes, ok }) => {
    const { pk, sk, title, content } = input as { pk: string; sk: string; title: string; content: string };
    await notes.put({ pk, sk, data: { tag: "note" as const, title, content } });
    return ok({ created: true }, 201);
  }, { public: true })

  // Table CRUD: get note by pk + sk
  .get("/notes/{pk}/{sk}", async ({ req, notes, ok, fail }) => {
    const item = await notes.get({ pk: req.params.pk!, sk: req.params.sk! });
    if (!item) return fail("not found", 404);
    return ok(item);
  }, { public: true })

  // Table CRUD: list notes by pk
  .get("/notes/{pk}", async ({ req, notes, ok }) => {
    const items = await notes.query({ pk: req.params.pk! });
    return ok({ items });
  }, { public: true })

  // Table CRUD: delete note
  .delete("/notes/{pk}/{sk}", async ({ req, notes, ok }) => {
    await notes.delete({ pk: req.params.pk!, sk: req.params.sk! });
    return ok({ deleted: true });
  }, { public: true })

  // Audit log: query stream events by note pk (same table, sk prefix)
  .get("/audit/{pk}", async ({ req, notes, ok }) => {
    const items = await notes.query({ pk: req.params.pk!, sk: { begins_with: "audit#" } });
    return ok({ items });
  }, { public: true });
