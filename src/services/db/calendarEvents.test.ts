import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

let db: TestDb;
vi.mock("./connection", () => ({ getDb: async () => db }));

import { deleteEventsMissingFromWindow } from "./calendarEvents";

describe("deleteEventsMissingFromWindow", () => {
  beforeEach(() => {
    db = createTestDb();
    db.raw.exec(`
      INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com');
      INSERT INTO calendars (id, account_id, provider, remote_id) VALUES ('cal-1', 'acc-1', 'caldav', '/cal/');
      INSERT INTO calendar_events (id, account_id, calendar_id, google_event_id, remote_event_id, start_time, end_time) VALUES
        ('e1', 'acc-1', 'cal-1', 'kept', 'kept', 150, 160),
        ('e2', 'acc-1', 'cal-1', 'gone', 'gone', 150, 160),
        ('e3', 'acc-1', 'cal-1', 'before', 'before', 50, 60);
    `);
  });

  it("removes what the server no longer lists in the range and leaves the rest", async () => {
    await deleteEventsMissingFromWindow("cal-1", 100, 200, ["kept"]);

    const rows = await db.select<{ id: string }[]>("SELECT id FROM calendar_events ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual(["e1", "e3"]);
  });
});
