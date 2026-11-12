import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

let db: TestDb;
vi.mock("../db/connection", () => ({
  getDb: async () => db,
  withTransaction: async (fn: (d: TestDb) => Promise<void>) => fn(db),
}));

import { snoozeThread, checkSnoozedThreads } from "./snoozeManager";

describe("snooze", () => {
  beforeEach(() => {
    db = createTestDb();
    db.raw.exec(`
      INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com');
      INSERT INTO threads (id, account_id, subject) VALUES ('t1', 'acc-1', 'Hello');
      INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('acc-1', 't1', 'INBOX');
    `);
  });

  it("wakes a thread into the inbox and out of Snoozed", async () => {
    await snoozeThread("acc-1", "t1", 1);
    await checkSnoozedThreads();

    const labels = await db.select<{ label_id: string }[]>(
      "SELECT label_id FROM thread_labels WHERE thread_id = 't1' ORDER BY label_id",
    );
    expect(labels.map((l) => l.label_id)).toEqual(["INBOX"]);
  });
});
