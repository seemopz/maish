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
    const threads = await db.select<{ id: string }[]>("SELECT id FROM threads");
    expect(threads.map((t) => t.id)).not.toContain("imap-sent-1");
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
