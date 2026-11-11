import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

// Delta sync against the real schema: these cases are about which rows end up
// in the database, which the mocked-db tests in imapSync.test.ts cannot see.
let db: TestDb;
vi.mock("../db/connection", () => ({
  getDb: async () => db,
  withTransaction: async (fn: () => Promise<void>) => fn(),
}));
vi.mock("./tauriCommands", () => ({
  imapListFolders: vi.fn(),
  imapGetFolderStatus: vi.fn(),
  imapFetchMessages: vi.fn(),
  imapFetchNewUids: vi.fn(),
  imapSearchFolder: vi.fn(),
  imapDeltaCheck: vi.fn(),
}));
vi.mock("../logFile", () => ({ logToFile: vi.fn() }));
vi.mock("./imapReconcile", () => ({ reconcileFolder: vi.fn() }));
vi.mock("./imapConfigBuilder", () => ({ buildImapConfig: vi.fn(() => ({})) }));
vi.mock("./folderMapper", () => ({
  mapFolderToLabel: vi.fn((folder: { path: string }) => ({
    labelId: folder.path === "Sent" ? "SENT" : folder.path,
    labelName: folder.path,
    type: "system",
  })),
  getLabelsForMessage: vi.fn((mapping: { labelId: string }) => [mapping.labelId]),
  syncFoldersToLabels: vi.fn(),
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(async () => ({ id: "acc-1", auth_method: "password" })),
  updateAccountSyncState: vi.fn(),
}));

import { imapDeltaSync } from "./imapSync";
import { imapListFolders, imapDeltaCheck, imapFetchMessages } from "./tauriCommands";
import { upsertThread, setThreadLabels } from "../db/threads";
import { upsertMessage } from "../db/messages";
import { upsertFolderSyncState } from "../db/folderSyncState";
import { generateThreadId, legacyThreadId } from "../threading/threadBuilder";
import {
  createMockImapMessage,
  createMockImapFolder,
  createMockImapFolderStatus,
} from "@/test/mocks";

async function storeLocalSentCopy(id: string, messageIdHeader: string) {
  await upsertThread({
    id,
    accountId: "acc-1",
    subject: "Hello",
    snippet: "Hi",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    isRead: true,
    isStarred: false,
    isImportant: false,
    hasAttachments: false,
  });
  await setThreadLabels("acc-1", id, ["SENT"]);
  await upsertMessage({
    id,
    accountId: "acc-1",
    threadId: id,
    fromAddress: "me@example.com",
    fromName: null,
    toAddresses: "you@example.com",
    ccAddresses: null,
    bccAddresses: null,
    replyTo: null,
    subject: "Hello",
    snippet: "Hi",
    date: 1_700_000_000_000,
    isRead: true,
    isStarred: false,
    bodyHtml: null,
    bodyText: "Hi",
    rawSize: 10,
    internalDate: 1_700_000_000_000,
    messageIdHeader,
    referencesHeader: null,
    inReplyToHeader: null,
  });
}

async function deltaSyncSent(messages: ReturnType<typeof createMockImapMessage>[]) {
  vi.mocked(imapListFolders).mockResolvedValue([
    createMockImapFolder({ path: "Sent", raw_path: "Sent", exists: messages.length }),
  ]);
  vi.mocked(imapDeltaCheck).mockResolvedValue([
    { folder: "Sent", uidvalidity: 1, new_uids: messages.map((m) => m.uid), uidvalidity_changed: false },
  ]);
  vi.mocked(imapFetchMessages).mockResolvedValue({
    messages,
    folder_status: createMockImapFolderStatus({ uidvalidity: 1, exists: messages.length }),
  });
  await imapDeltaSync("acc-1");
}

describe("imapDeltaSync with the real schema", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
    db.raw.exec("INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com')");
    await upsertFolderSyncState({
      account_id: "acc-1",
      folder_path: "Sent",
      uidvalidity: 1,
      last_uid: 4,
      modseq: null,
      last_sync_at: 0,
    });
  });

  it("replaces the local copy of a sent mail once the server's Sent copy arrives", async () => {
    // The SMTP path stores the raw header, brackets included; the server copy
    // arrives without them (mail-parser strips them).
    await storeLocalSentCopy("imap-sent-1", "<abc@example.com>");

    await deltaSyncSent([
      createMockImapMessage({
        uid: 5,
        folder: "Sent",
        message_id: "abc@example.com",
        subject: "Hello",
        from_address: "me@example.com",
        is_read: true,
      }),
    ]);

    const messages = await db.select<{ id: string }[]>("SELECT id FROM messages ORDER BY id");
    expect(messages.map((m) => m.id)).toEqual(["imap-acc-1-Sent-5"]);
    // One conversation, no empty leftover (the synced copy may keep the local thread).
    const threads = await db.select<{ id: string; n: number }[]>(
      "SELECT t.id, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS n FROM threads t",
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.n).toBe(1);
  });

  it("drops the local thread when the synced copy lands in another one", async () => {
    // The synced copy answers an older stored message, so the lookup puts it
    // into that thread and the local row's own thread is left empty.
    await storeLocalSentCopy("imap-sent-1", "<abc@example.com>");
    db.raw.exec("INSERT INTO threads (id, account_id, subject) VALUES ('t-other', 'acc-1', 'Hello')");
    db.raw.exec(
      "INSERT INTO messages (id, account_id, thread_id, date, message_id_header, imap_uid, imap_folder) VALUES ('imap-acc-1-INBOX-1', 'acc-1', 't-other', 0, 'parent@example.com', 1, 'INBOX')",
    );

    await deltaSyncSent([
      createMockImapMessage({
        uid: 5,
        folder: "Sent",
        message_id: "abc@example.com",
        in_reply_to: "<parent@example.com>",
        subject: "Hello",
      }),
    ]);

    const threads = await db.select<{ id: string }[]>("SELECT id FROM threads ORDER BY id");
    expect(threads.map((t) => t.id)).toEqual(["t-other"]);
  });

  it("keeps a local sent copy whose Message-ID the server has not delivered yet", async () => {
    await storeLocalSentCopy("imap-sent-1", "<other@example.com>");

    await deltaSyncSent([
      createMockImapMessage({ uid: 5, folder: "Sent", message_id: "abc@example.com" }),
    ]);

    const messages = await db.select<{ id: string }[]>("SELECT id FROM messages ORDER BY id");
    expect(messages.map((m) => m.id)).toEqual(["imap-acc-1-Sent-5", "imap-sent-1"]);
  });
});

describe("imapDeltaSync joins replies to the threads they belong to", () => {
  async function storeMessage(threadId: string, id: string, messageIdHeader: string, references: string | null) {
    db.raw.prepare("INSERT OR IGNORE INTO threads (id, account_id, subject) VALUES (?, 'acc-1', 'Plans')").run(threadId);
    db.raw
      .prepare(
        "INSERT INTO messages (id, account_id, thread_id, subject, date, message_id_header, references_header, imap_uid, imap_folder) VALUES (?, 'acc-1', ?, 'Plans', 1, ?, ?, 1, 'INBOX')",
      )
      .run(id, threadId, messageIdHeader, references);
  }
  async function threadOf(id: string): Promise<string | undefined> {
    const rows = await db.select<{ thread_id: string }[]>("SELECT thread_id FROM messages WHERE id = $1", [id]);
    return rows[0]?.thread_id;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
    db.raw.exec("INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com')");
    await upsertFolderSyncState({
      account_id: "acc-1",
      folder_path: "Sent",
      uidvalidity: 1,
      last_uid: 4,
      modseq: null,
      last_sync_at: 0,
    });
  });

  it("puts a reply into the thread that already holds the message it answers", async () => {
    // Stored under an id the reply's own root does not hash to (the initial
    // sync threaded it under an older root, or merged it by subject).
    await storeMessage("t-existing", "imap-acc-1-INBOX-1", "parent@example.com", "older@example.com");

    await deltaSyncSent([
      createMockImapMessage({
        uid: 5,
        folder: "Sent",
        message_id: "reply@example.com",
        in_reply_to: "<parent@example.com>",
        references: null,
        subject: "Re: Plans",
      }),
    ]);

    expect(await threadOf("imap-acc-1-Sent-5")).toBe("t-existing");
  });

  it("keeps using a thread stored under the old 32-bit id when nothing it holds is referenced", async () => {
    // Root never stored, only a sibling reply: the lookup by Message-ID finds nothing.
    const old = legacyThreadId("root@example.com");
    await storeMessage(old, "imap-acc-1-INBOX-1", "sibling@example.com", "<root@example.com>");

    await deltaSyncSent([
      createMockImapMessage({
        uid: 5,
        folder: "Sent",
        message_id: "reply@example.com",
        in_reply_to: "<root@example.com>",
        references: "<root@example.com>",
        subject: "Re: Plans",
      }),
    ]);

    expect(await threadOf("imap-acc-1-Sent-5")).toBe(old);
  });

  it("does not merge new conversations whose roots collide in 32 bits", () => {
    // "hetairas" and "mentioner" share a djb2 hash.
    expect(legacyThreadId("hetairas")).toBe(legacyThreadId("mentioner"));
    expect(generateThreadId("hetairas")).not.toBe(generateThreadId("mentioner"));
  });
});
