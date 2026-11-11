import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

let db: TestDb;
vi.mock("./connection", () => ({ getDb: async () => db }));

import { claimScheduledEmail, getPendingScheduledEmails, requeueInterruptedScheduledEmails } from "./scheduledEmails";

describe("scheduled emails interrupted mid-send", () => {
  beforeEach(() => {
    db = createTestDb();
    db.raw.exec(`
      INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com');
      INSERT INTO scheduled_emails (id, account_id, to_addresses, body_html, scheduled_at)
        VALUES ('s1', 'acc-1', 'you@example.com', '<p>hi</p>', 1);
    `);
  });

  it("are picked up again after a restart instead of staying in 'sending' for good", async () => {
    expect(await claimScheduledEmail("s1")).toBe(true);
    // The app quit before the send finished.
    expect(await getPendingScheduledEmails()).toHaveLength(0);

    await requeueInterruptedScheduledEmails();

    expect((await getPendingScheduledEmails()).map((e) => e.id)).toEqual(["s1"]);
  });
});
