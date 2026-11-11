import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

// Local DB effects of actions, against the real schema.
let db: TestDb;
vi.mock("@/services/db/connection", () => ({
  getDb: async () => db,
  withTransaction: async (fn: () => Promise<void>) => fn(),
}));
vi.mock("@/stores/uiStore", () => ({
  useUIStore: { getState: () => ({ isOnline: true }) },
}));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: { getState: () => ({ updateThread: vi.fn(), removeThread: vi.fn(), threads: [] }) },
}));
vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));
vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  getSelectedThreadId: vi.fn(() => null),
}));
const moveToFolder = vi.fn(async () => {});
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(async () => ({ moveToFolder })),
}));

import { moveThread } from "./emailActions";

async function labelsOf(threadId: string): Promise<string[]> {
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1 ORDER BY label_id",
    [threadId],
  );
  return rows.map((r) => r.label_id);
}

describe("moveThread on an IMAP account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    db.raw.exec(`
      INSERT INTO accounts (id, email, provider) VALUES ('acc-1', 'me@example.com', 'imap');
      INSERT INTO labels (id, account_id, name, type, imap_folder_path) VALUES
        ('INBOX', 'acc-1', 'Inbox', 'system', 'INBOX'),
        ('STARRED', 'acc-1', 'Starred', 'system', 'Flagged'),
        ('folder-Projects', 'acc-1', 'Projects', 'user', 'Projects');
      INSERT INTO threads (id, account_id, subject) VALUES ('t1', 'acc-1', 'Hello');
      INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES
        ('acc-1', 't1', 'INBOX'), ('acc-1', 't1', 'STARRED'), ('acc-1', 't1', 'UNREAD');
    `);
  });

  it("takes the thread out of its folder and into the destination locally", async () => {
    await moveThread("acc-1", "t1", ["imap-acc-1-INBOX-5"], "folder-Projects", { undo: false });

    expect(moveToFolder).toHaveBeenCalled();
    // A sync that reloads the list must not find it in the inbox again.
    expect(await labelsOf("t1")).toEqual(["STARRED", "UNREAD", "folder-Projects"]);
  });
});
