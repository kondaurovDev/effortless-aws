import { defineTable } from "effortless-aws";

// ── Single table: all domains (discriminated by tag) ─────────

type NoteData = { tag: "note"; title: string; content: string };
type AuditData = { tag: "audit"; type: string; notePk: string; noteSk: string };
type ContactData = { tag: "contact"; name: string; email: string; company?: string };

type Data = NoteData | AuditData | ContactData;

export const db = defineTable<Data>({
  streamView: "NEW_AND_OLD_IMAGES",
})
  .setup(({ table }) => ({ table }))
  .onRecord(async ({ record, table }) => {
    // Only audit note events (skip audit + contact to prevent loops / noise)
    const data = record.new?.data ?? record.old?.data;
    if (data?.tag !== "note") return;

    await table.put({
      pk: record.keys.pk,
      sk: `audit#${record.eventName}#${record.keys.sk}#${Date.now()}`,
      data: { tag: "audit", type: record.eventName, notePk: record.keys.pk, noteSk: record.keys.sk },
    });
  });
