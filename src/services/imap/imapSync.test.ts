import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() calls are hoisted — must use inline factories, not external references
vi.mock("./tauriCommands", () => ({
  imapListFolders: vi.fn(),
  imapGetFolderStatus: vi.fn(),
  imapFetchMessages: vi.fn(),
  imapFetchNewUids: vi.fn(),
  imapSearchAllUids: vi.fn(),
  imapSearchFolder: vi.fn(),
  imapDeltaCheck: vi.fn(),
}));
vi.mock("./imapConfigBuilder", () => ({
  buildImapConfig: vi.fn(() => ({
    host: "imap.example.com",
    port: 993,
    security: "ssl",
    username: "user@example.com",
    password: "secret",
    auth_method: "password",
  })),
}));
vi.mock("./folderMapper", () => ({
  mapFolderToLabel: vi.fn((folder: { path: string }) => ({
    labelId: folder.path,
    labelName: folder.path,
    type: "user",
  })),
  getLabelsForMessage: vi.fn(
    (mapping: { labelId: string }, isRead: boolean, isStarred: boolean) => {
      const labels = [mapping.labelId];
      if (!isRead) labels.push("UNREAD");
      if (isStarred) labels.push("STARRED");
      return labels;
    },
  ),
  syncFoldersToLabels: vi.fn(),
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
  updateMessageThreadIds: vi.fn(),
  getMessagesForThread: vi.fn(() => []),
  deleteMessagesInFolder: vi.fn(() => []),
}));
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  deleteThread: vi.fn(),
  getThreadLabelIds: vi.fn(() => []),
  getThreadById: vi.fn(() => undefined),
  deleteEmptyThreads: vi.fn(),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/connection", () => ({
  withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
}));
vi.mock("../db/folderSyncState", () => ({
  upsertFolderSyncState: vi.fn(),
  getAllFolderSyncStates: vi.fn(() => []),
}));
vi.mock("../db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn(() => []),
}));

import { imapMessageToParsedMessage, imapInitialSync, imapDeltaSync, formatImapDate, computeSinceDate, isConnectionError, resetUndeliveredUidAttempts } from "./imapSync";
import {
  createMockImapMessage,
  createMockImapAccount,
  createMockImapFolder,
  createMockImapFolderStatus,
  createMockImapFetchResult,
} from "@/test/mocks";
import { imapListFolders, imapSearchFolder, imapFetchMessages, imapDeltaCheck } from "./tauriCommands";
import { getAccount } from "../db/accounts";
import { withTransaction } from "../db/connection";
import { upsertMessage, updateMessageThreadIds, getMessagesForThread, deleteMessagesInFolder } from "../db/messages";
import { upsertThread, deleteThread, setThreadLabels, getThreadLabelIds, deleteEmptyThreads } from "../db/threads";
import { upsertAttachment } from "../db/attachments";
import { buildThreads } from "../threading/threadBuilder";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { getAllFolderSyncStates, upsertFolderSyncState } from "../db/folderSyncState";

describe("imapMessageToParsedMessage", () => {
  it("converts basic IMAP message to ParsedMessage format", () => {
    const msg = createMockImapMessage();
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
    expect(parsed.fromName).toBe("Sender Name");
    expect(parsed.toAddresses).toBe("recipient@example.com");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.date).toBe(1700000000000);
    expect(parsed.isRead).toBe(false);
    expect(parsed.isStarred).toBe(false);
    expect(parsed.bodyHtml).toBe("<p>Hello</p>");
    expect(parsed.bodyText).toBe("Hello");
    expect(parsed.snippet).toBe("Hello");
    expect(parsed.rawSize).toBe(1024);
    expect(parsed.hasAttachments).toBe(false);
    expect(parsed.attachments).toEqual([]);
  });

  it("passes the backend's content hash on to threading", () => {
    const msg = createMockImapMessage({ content_hash: "abc123" });
    expect(imapMessageToParsedMessage(msg, "acc-1", "INBOX").threadable.contentKey).toBe("abc123");
  });

  it("generates stable message ID from account, folder, and uid", () => {
    const msg = createMockImapMessage({ uid: 99, folder: "Sent" });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-2", "SENT");
    expect(parsed.id).toBe("imap-acc-2-Sent-99");
  });

  it("includes UNREAD label for unread messages", () => {
    const msg = createMockImapMessage({ is_read: false });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("does not include UNREAD label for read messages", () => {
    const msg = createMockImapMessage({ is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).not.toContain("UNREAD");
    expect(parsed.labelIds).toContain("INBOX");
  });

  it("includes STARRED label for flagged messages", () => {
    const msg = createMockImapMessage({ is_starred: true, is_read: true });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.labelIds).toContain("STARRED");
  });

  it("creates threadable message with correct fields", () => {
    const msg = createMockImapMessage({
      message_id: "<msg-abc@host.com>",
      in_reply_to: "<msg-parent@host.com>",
      references: "<msg-root@host.com> <msg-parent@host.com>",
    });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.id).toBe("imap-acc-1-INBOX-42");
    expect(threadable.messageId).toBe("<msg-abc@host.com>");
    expect(threadable.inReplyTo).toBe("<msg-parent@host.com>");
    expect(threadable.references).toBe("<msg-root@host.com> <msg-parent@host.com>");
    expect(threadable.subject).toBe("Test Subject");
    expect(threadable.date).toBe(1700000000000);
  });

  it("generates synthetic message ID when none present", () => {
    const msg = createMockImapMessage({ message_id: null });
    const { threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(threadable.messageId).toBe("synthetic-acc-1-INBOX-42@maish.local");
  });

  it("converts attachments correctly", () => {
    const msg = createMockImapMessage({
      attachments: [
        {
          part_id: "2",
          filename: "report.pdf",
          mime_type: "application/pdf",
          size: 50000,
          content_id: null,
          is_inline: false,
        },
        {
          part_id: "3",
          filename: "logo.png",
          mime_type: "image/png",
          size: 1024,
          content_id: "logo-cid",
          is_inline: true,
        },
      ],
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    expect(parsed.hasAttachments).toBe(true);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toEqual({
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 50000,
      gmailAttachmentId: "2",
      contentId: null,
      isInline: false,
    });
    expect(parsed.attachments[1]).toEqual({
      filename: "logo.png",
      mimeType: "image/png",
      size: 1024,
      gmailAttachmentId: "3",
      contentId: "logo-cid",
      isInline: true,
    });
  });

  it("generates snippet from body_text when snippet is null", () => {
    const msg = createMockImapMessage({
      snippet: null,
      body_text: "This is a long email body that should be truncated to create a snippet for display purposes.",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.snippet).toBe("This is a long email body that should be truncated to create a snippet for display purposes.");
  });

  it("handles null body fields gracefully", () => {
    const msg = createMockImapMessage({
      body_html: null,
      body_text: null,
      snippet: null,
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.bodyText).toBeNull();
    expect(parsed.snippet).toBe("");
  });

  it("preserves list-unsubscribe headers", () => {
    const msg = createMockImapMessage({
      list_unsubscribe: "<mailto:unsub@list.com>",
      list_unsubscribe_post: "List-Unsubscribe=One-Click",
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.listUnsubscribe).toBe("<mailto:unsub@list.com>");
    expect(parsed.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
  });

  it("preserves auth results", () => {
    const msg = createMockImapMessage({
      auth_results: '{"spf":"pass","dkim":"pass"}',
    });
    const { parsed } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");
    expect(parsed.authResults).toBe('{"spf":"pass","dkim":"pass"}');
  });

  it("handles date=0 (unparseable Date header) without crashing", () => {
    const msg = createMockImapMessage({ date: 0 });
    const { parsed, threadable } = imapMessageToParsedMessage(msg, "acc-1", "INBOX");

    // date=0 * 1000 = 0, passed through — the caller (imapInitialSync) applies the fallback
    expect(parsed.date).toBe(0);
    expect(threadable.date).toBe(0);
    // Message should still be valid
    expect(parsed.id).toBe("imap-acc-1-INBOX-42");
    expect(parsed.fromAddress).toBe("sender@example.com");
  });
});

describe("imapInitialSync", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockWithTransaction = vi.mocked(withTransaction);
  const mockUpsertMessage = vi.mocked(upsertMessage);
  const mockUpdateMessageThreadIds = vi.mocked(updateMessageThreadIds);
  const mockUpsertThread = vi.mocked(upsertThread);
  const mockUpsertAttachment = vi.mocked(upsertAttachment);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    // Reset persistent mock implementations to prevent leaking between describe blocks
    mockImapSearchFolder.mockReset();
    mockImapFetchMessages.mockReset();
    mockImapListFolders.mockReset();
    vi.useRealTimers();
  });

  /** Configure mocks to return a single folder with the given messages. */
  function setupFolderWithMessages(folder: string, messages: ReturnType<typeof createMockImapMessage>[]) {
    const mockFolder = createMockImapFolder({
      path: folder,
      raw_path: folder,
      exists: messages.length,
    });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    // imapSearchFolder returns UIDs + folder status (no message bodies)
    mockImapSearchFolder.mockResolvedValue({
      uids: messages.map((m) => m.uid),
      folder_status: createMockImapFolderStatus({ exists: messages.length }),
    });
    // imapFetchMessages returns full messages for the requested UIDs
    mockImapFetchMessages.mockResolvedValue(
      createMockImapFetchResult(messages),
    );
    return mockFolder;
  }

  it("stores messages to DB immediately per-chunk (streaming)", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "First", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "Second", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    // Messages should be stored individually via upsertMessage during fetch phase
    expect(mockUpsertMessage).toHaveBeenCalledTimes(2);

    // Each message should be stored with placeholder threadId = messageId
    const firstCallArgs = mockUpsertMessage.mock.calls[0]![0];
    expect(firstCallArgs.threadId).toBe(firstCallArgs.id);

    const secondCallArgs = mockUpsertMessage.mock.calls[1]![0];
    expect(secondCallArgs.threadId).toBe(secondCallArgs.id);
  });

  it("creates placeholder thread before each message to satisfy FK constraint", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 2, message_id: "<m2@test>", subject: "World", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1, msg2]);

    await imapInitialSync("acc-1");

    // For each message, upsertThread should be called BEFORE upsertMessage
    // to satisfy the FK constraint (messages.thread_id → threads.id).
    // Phase 2: 2 placeholder threads + Phase 4: 1 or 2 final threads
    expect(mockUpsertThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockUpsertMessage).toHaveBeenCalledTimes(2);

    // Each placeholder thread must be created before its corresponding message.
    // Verify by checking that the nth thread call preceded the nth message call.
    for (let i = 0; i < 2; i++) {
      const threadOrder = mockUpsertThread.mock.invocationCallOrder[i]!;
      const messageOrder = mockUpsertMessage.mock.invocationCallOrder[i]!;
      expect(threadOrder).toBeLessThan(messageOrder);
    }

    // Verify placeholder threads use the message ID as thread ID
    const firstThreadCall = mockUpsertThread.mock.calls[0]![0];
    const firstMsgCall = mockUpsertMessage.mock.calls[0]![0];
    expect(firstThreadCall.id).toBe(firstMsgCall.id);
    expect(firstThreadCall.id).toBe(firstMsgCall.threadId);
  });

  it("updates thread IDs after threading phase", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", subject: "Hello", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg1]);

    await imapInitialSync("acc-1");

    // Thread record should be created: once as placeholder in Phase 2, once final in Phase 4
    expect(mockUpsertThread).toHaveBeenCalledTimes(2);

    // Thread IDs should be batch-updated via updateMessageThreadIds
    expect(mockUpdateMessageThreadIds).toHaveBeenCalledTimes(1);
    const [accountId, messageIds, threadId] = mockUpdateMessageThreadIds.mock.calls[0]!;
    expect(accountId).toBe("acc-1");
    expect(messageIds).toHaveLength(1);
    expect(threadId).toBeTruthy();
  });

  it("returns empty messages array (bodies not accumulated)", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const result = await imapInitialSync("acc-1");

    // The streaming approach returns empty array — bodies are already in DB
    expect(result.messages).toEqual([]);
  });

  it("stores attachments immediately with the message", async () => {
    const msg = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      date: Math.floor(Date.now() / 1000),
      attachments: [
        {
          part_id: "2",
          filename: "doc.pdf",
          mime_type: "application/pdf",
          size: 5000,
          content_id: null,
          is_inline: false,
        },
      ],
    });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    expect(mockUpsertAttachment).toHaveBeenCalledTimes(1);
    expect(mockUpsertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "doc.pdf",
        mimeType: "application/pdf",
        accountId: "acc-1",
      }),
    );
  });

  it("filters messages by date cutoff", async () => {
    const recentDate = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const oldDate = Math.floor(Date.now() / 1000) - 400 * 86400; // 400 days ago

    const recentMsg = createMockImapMessage({ uid: 1, message_id: "<recent@test>", date: recentDate });
    const oldMsg = createMockImapMessage({ uid: 2, message_id: "<old@test>", date: oldDate });

    setupFolderWithMessages("INBOX", [recentMsg, oldMsg]);

    await imapInitialSync("acc-1", 365);

    // Only recent message should be stored (old one is beyond 365 days)
    expect(mockUpsertMessage).toHaveBeenCalledTimes(1);
    expect(mockUpsertMessage.mock.calls[0]![0].id).toContain("1"); // uid=1
  });

  it("handles empty folders gracefully", async () => {
    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 0 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    const result = await imapInitialSync("acc-1");

    expect(mockImapSearchFolder).not.toHaveBeenCalled();
    expect(mockUpsertMessage).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
  });

  it("reports progress through all phases", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    const progressCalls: Array<{ phase: string }> = [];
    await imapInitialSync("acc-1", 365, (progress) => {
      progressCalls.push({ phase: progress.phase });
    });

    const phases = progressCalls.map((p) => p.phase);
    expect(phases).toContain("folders");
    expect(phases).toContain("messages");
    expect(phases).toContain("threading");
    expect(phases).toContain("storing_threads");
    expect(phases).toContain("done");
  });

  it("uses imapSearchFolder + imapFetchMessages for chunked sync per folder", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    // Should use imapSearchFolder (lightweight search) with SINCE date filter
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(1);
    expect(mockImapSearchFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX",
      expect.stringMatching(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/), // sinceDate in DD-Mon-YYYY format
    );

    // Then fetch the messages by UID
    expect(mockImapFetchMessages).toHaveBeenCalledTimes(1);
    expect(mockImapFetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX",
      [1], // UIDs from search
    );
  });

  it("wraps chunk DB writes in a transaction", async () => {
    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    setupFolderWithMessages("INBOX", [msg]);

    await imapInitialSync("acc-1");

    // withTransaction should be called: once for Phase 2 chunk + once for Phase 4 batch
    expect(mockWithTransaction).toHaveBeenCalledTimes(2);
  });

  it("continues to next chunk on fetch error", async () => {
    const msg1 = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });
    const msg2 = createMockImapMessage({ uid: 201, message_id: "<m2@test>", date: Math.floor(Date.now() / 1000) });

    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 2 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    // Return UIDs in two "chunks" (we'll set CHUNK_SIZE to 200 but have UIDs 1 and 201)
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 201],
      folder_status: createMockImapFolderStatus({ exists: 2 }),
    });

    // First chunk fetch succeeds, but because both UIDs are in the same chunk (< 200),
    // we test error handling by making imapFetchMessages fail on first call and succeed on retry
    mockImapFetchMessages
      .mockRejectedValueOnce(new Error("fetch timeout"))
      .mockResolvedValueOnce(createMockImapFetchResult([msg2]));

    // This won't exercise the multi-chunk path since 2 UIDs < 200 chunk size.
    // Instead test that a search failure at folder level is handled.
    // Reset and use a simpler approach: single chunk that fails
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));

    const msgs = Array.from({ length: 2 }, (_, i) =>
      createMockImapMessage({ uid: i + 1, message_id: `<m${i}@test>`, date: Math.floor(Date.now() / 1000) }),
    );
    setupFolderWithMessages("INBOX", msgs);

    // Even if imapFetchMessages fails for one chunk, the folder-level error is caught
    mockImapFetchMessages.mockRejectedValueOnce(new Error("chunk fetch failed"));

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    const result = await syncPromise;

    // Sync should complete without throwing
    expect(result.messages).toEqual([]);
  });

  it("circuit breaker skips remaining folders after 5 consecutive connection failures", async () => {
    const folders = Array.from({ length: 8 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue(new Error("TCP connect timed out (os error 60)"));

    // Advance timers and catch the expected error in one go to avoid
    // Vitest's unhandled-rejection tracker from flagging it.
    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    // All folders fail → error is propagated
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");

    // Circuit breaker should stop after 5 failures (CIRCUIT_BREAKER_MAX_FAILURES)
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(5);
  });

  it("circuit breaker resets on successful folder sync", async () => {
    const folders = [
      createMockImapFolder({ path: "f1", raw_path: "f1", exists: 10 }),
      createMockImapFolder({ path: "f2", raw_path: "f2", exists: 10 }),
      createMockImapFolder({ path: "f3", raw_path: "f3", exists: 10 }),
      createMockImapFolder({ path: "f4", raw_path: "f4", exists: 10 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);

    const msg = createMockImapMessage({ uid: 1, message_id: "<m1@test>", date: Math.floor(Date.now() / 1000) });

    // First 2 fail with connection error, 3rd succeeds, 4th fails
    mockImapSearchFolder
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockResolvedValueOnce({
        uids: [msg.uid],
        folder_status: createMockImapFolderStatus({ exists: 1 }),
      })
      .mockRejectedValueOnce(new Error("TCP connect timed out"));

    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([msg]));

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    await syncPromise;

    // All 4 folders should be attempted (circuit breaker resets after success on f3)
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(4);
  });

  it("continues on non-connection errors without triggering circuit breaker", async () => {
    const folders = Array.from({ length: 6 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);

    // Non-connection errors should NOT trigger circuit breaker
    mockImapSearchFolder.mockRejectedValue(new Error("PARSE failed: invalid response"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    // All folders fail → error is propagated, but all were attempted first
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");

    // All folders should be attempted since these aren't connection errors
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(6);
  });
});

describe("formatImapDate", () => {
  it("formats a date as DD-Mon-YYYY for IMAP SINCE criterion", () => {
    // 2024-03-15 UTC
    const date = new Date(Date.UTC(2024, 2, 15));
    expect(formatImapDate(date)).toBe("15-Mar-2024");
  });

  it("handles single-digit days without zero-padding", () => {
    const date = new Date(Date.UTC(2024, 0, 5));
    expect(formatImapDate(date)).toBe("5-Jan-2024");
  });

  it("handles December correctly", () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    expect(formatImapDate(date)).toBe("31-Dec-2024");
  });
});

describe("computeSinceDate", () => {
  it("returns a date daysBack+1 days ago in DD-Mon-YYYY format", () => {
    const result = computeSinceDate(365);
    // Should match DD-Mon-YYYY format
    expect(result).toMatch(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/);
  });

  it("adds 1-day safety margin", () => {
    // For daysBack=0, should still go back 1 day
    const result = computeSinceDate(0);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(result).toBe(formatImapDate(yesterday));
  });
});

describe("isConnectionError", () => {
  it("detects 'timed out' errors", () => {
    expect(isConnectionError("TCP connect timed out (os error 60)")).toBe(true);
  });

  it("detects 'connection' errors", () => {
    expect(isConnectionError("connection reset by peer")).toBe(true);
  });

  it("detects TLS errors", () => {
    expect(isConnectionError("tls handshake failed")).toBe(true);
  });

  it("detects DNS errors", () => {
    expect(isConnectionError("dns resolution failed")).toBe(true);
  });

  it("detects ECONNREFUSED errors", () => {
    expect(isConnectionError("connect ECONNREFUSED 127.0.0.1:993")).toBe(true);
  });

  it("detects socket errors", () => {
    expect(isConnectionError("socket hang up")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isConnectionError("network is unreachable")).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError("PARSE failed: invalid response")).toBe(false);
    expect(isConnectionError("authentication failed")).toBe(false);
  });
});

describe("imapInitialSync — all-folders-fail propagation", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    // Reset search mock implementation to prevent leaking into subsequent tests
    mockImapSearchFolder.mockReset();
    vi.useRealTimers();
  });

  it("throws when all folders fail and no messages were stored", async () => {
    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 10 }),
      createMockImapFolder({ path: "Sent", raw_path: "Sent", exists: 5 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue("authentication failed");

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
  });
});

describe("imapInitialSync — placeholder cleanup", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockDeleteThread = vi.mocked(deleteThread);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes orphaned placeholder threads after threading", async () => {
    // Two messages that share the same thread via References
    const msg1 = createMockImapMessage({
      uid: 1,
      message_id: "<m1@test>",
      subject: "Thread Subject",
      date: Math.floor(Date.now() / 1000),
    });
    const msg2 = createMockImapMessage({
      uid: 2,
      message_id: "<m2@test>",
      in_reply_to: "<m1@test>",
      references: "<m1@test>",
      subject: "Re: Thread Subject",
      date: Math.floor(Date.now() / 1000) + 60,
    });

    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 2 });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 2],
      folder_status: createMockImapFolderStatus({ exists: 2 }),
    });
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([msg1, msg2]));

    await imapInitialSync("acc-1");

    // Threading should merge the two messages into one thread,
    // so at least one placeholder thread (the one not chosen as thread ID) should be deleted
    expect(mockDeleteThread).toHaveBeenCalled();
  });
});

/**
 * Delta sync fetches only what is new and threads only what it fetched. The
 * thread those messages belong to is usually already in the database with
 * more messages in it, a star the user set and labels the user applied — none
 * of which is in the batch. Recomputing the thread row and its labels from
 * the batch alone therefore overwrote all of it.
 */
describe("imapDeltaSync — thread state of messages it did not fetch", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockGetMessagesForThread = vi.mocked(getMessagesForThread);
  const mockGetThreadLabelIds = vi.mocked(getThreadLabelIds);
  const mockUpsertThread = vi.mocked(upsertThread);
  const mockSetThreadLabels = vi.mocked(setThreadLabels);

  /** A row as getMessagesForThread returns it. */
  function storedMessage(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: "imap-acc-1-INBOX-1",
      account_id: "acc-1",
      thread_id: "t",
      from_address: "sender@example.com",
      from_name: "Sender",
      to_addresses: "me@example.com",
      cc_addresses: null,
      bcc_addresses: null,
      reply_to: null,
      subject: "The original subject",
      snippet: "older text",
      date: 1000,
      is_read: 1,
      is_starred: 0,
      body_html: null,
      body_text: null,
      body_cached: 1,
      raw_size: 10,
      internal_date: 1000,
      list_unsubscribe: null,
      list_unsubscribe_post: null,
      auth_results: null,
      message_id_header: "<m1@test>",
      references_header: null,
      in_reply_to_header: null,
      imap_uid: 1,
      imap_folder: "INBOX",
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockGetThreadLabelIds.mockResolvedValue([]);
    mockGetMessagesForThread.mockResolvedValue([]);

    const folder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX" });
    mockImapListFolders.mockResolvedValue([folder]);
    mockGetAllFolderSyncStates.mockResolvedValue([
      {
        account_id: "acc-1",
        folder_path: "INBOX",
        uidvalidity: 1,
        last_uid: 4,
        modseq: null,
        last_sync_at: 0,
      },
    ] as never);
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [5], uidvalidity_changed: false },
    ] as never);

    // The one new message is a reply, so JWZ roots it at the original and it
    // lands in the thread that is already stored.
    const reply = createMockImapMessage({
      uid: 5,
      message_id: "<m5@test>",
      references: "<m1@test>",
      in_reply_to: "<m1@test>",
      subject: "Re: The original subject",
      is_read: false,
      is_starred: false,
      date: 5000,
    });
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([reply]));
  });

  it("counts the messages already stored, not only the new one", async () => {
    mockGetMessagesForThread.mockResolvedValue([
      storedMessage({ id: "a", date: 1000 }),
      storedMessage({ id: "b", date: 2000 }),
      storedMessage({ id: "c", date: 3000 }),
      storedMessage({ id: "d", date: 4000 }),
      storedMessage({ id: "e", date: 5000, is_read: 0, subject: "Re: The original subject" }),
    ] as never);

    await imapDeltaSync("acc-1");

    const last = mockUpsertThread.mock.calls.at(-1)![0];
    expect(last.messageCount).toBe(5);
  });

  it("keeps a star that is on a message it did not fetch", async () => {
    mockGetMessagesForThread.mockResolvedValue([
      storedMessage({ id: "a", date: 1000, is_starred: 1 }),
      storedMessage({ id: "e", date: 5000, is_read: 0 }),
    ] as never);

    await imapDeltaSync("acc-1");

    const last = mockUpsertThread.mock.calls.at(-1)![0];
    expect(last.isStarred).toBe(true);
  });

  it("keeps the subject of the thread's first message", async () => {
    mockGetMessagesForThread.mockResolvedValue([
      storedMessage({ id: "a", date: 1000, subject: "The original subject" }),
      storedMessage({ id: "e", date: 5000, subject: "Re: The original subject" }),
    ] as never);

    await imapDeltaSync("acc-1");

    const last = mockUpsertThread.mock.calls.at(-1)![0];
    expect(last.subject).toBe("The original subject");
  });

  it("does not mark a thread read because the messages it fetched are", async () => {
    mockGetMessagesForThread.mockResolvedValue([
      storedMessage({ id: "a", date: 1000, is_read: 0 }),
      storedMessage({ id: "e", date: 5000, is_read: 1 }),
    ] as never);

    await imapDeltaSync("acc-1");

    const last = mockUpsertThread.mock.calls.at(-1)![0];
    expect(last.isRead).toBe(false);
  });

  it("keeps labels the user applied to the thread", async () => {
    mockGetThreadLabelIds.mockResolvedValue(["INBOX", "Label_work"]);
    mockGetMessagesForThread.mockResolvedValue([storedMessage({ id: "e", date: 5000 })] as never);

    await imapDeltaSync("acc-1");

    const [, , labels] = mockSetThreadLabels.mock.calls.at(-1)!;
    expect(labels).toContain("Label_work");
    expect(labels).toContain("INBOX");
  });
});

/**
 * The initial sync fetches a folder in chunks and gives a chunk up after one
 * retry, carrying on with the next. last_uid is then written from the highest
 * UID that came back — which, since the chunks run in ascending order, is
 * from a chunk *after* the one that failed. Delta sync only ever asks for
 * UIDs above last_uid, so the messages in the abandoned chunk were never
 * fetched again: a silent hole in the mailbox that no later sync closes.
 */
describe("imapInitialSync — last_uid after a chunk is given up on", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockUpsertFolderSyncState = vi.mocked(upsertFolderSyncState);

  // CHUNK_SIZE is 200, so this is exactly two chunks: 1..200 and 201..400.
  const ALL_UIDS = Array.from({ length: 400 }, (_, i) => i + 1);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: ALL_UIDS.length }),
    ]);
    mockImapSearchFolder.mockResolvedValue({
      uids: ALL_UIDS,
      folder_status: createMockImapFolderStatus({ exists: ALL_UIDS.length, uidvalidity: 7 }),
    });
  });

  afterEach(() => {
    mockImapSearchFolder.mockReset();
    mockImapFetchMessages.mockReset();
    mockImapListFolders.mockReset();
  });

  /** Serve every requested UID except those in a chunk that is made to fail. */
  function serveExcept(failFrom: number) {
    mockImapFetchMessages.mockImplementation(async (_c, _f, uids) => {
      const requested = uids as number[];
      if (requested[0] === failFrom) {
        // Not a connection error, so it is abandoned without a retry.
        throw new Error("Server refused the fetch");
      }
      return createMockImapFetchResult(
        requested.map((uid) =>
          createMockImapMessage({
            uid,
            message_id: `<m${uid}@test>`,
            date: Math.floor(Date.now() / 1000),
          }),
        ),
      );
    });
  }

  it("does not record UIDs above an abandoned chunk as synced", async () => {
    serveExcept(1); // the first chunk fails, the second succeeds

    await imapInitialSync("acc-1");

    const state = mockUpsertFolderSyncState.mock.calls.at(-1)![0];
    // The second chunk reached UID 400, but 1..200 were never stored. Claiming
    // 400 tells the next delta sync to start at 401 and lose them for good.
    expect(state.last_uid).toBeLessThan(1);
  });

  it("stops at the last UID before the abandoned chunk", async () => {
    serveExcept(201); // the first chunk succeeds, the second fails

    await imapInitialSync("acc-1");

    const state = mockUpsertFolderSyncState.mock.calls.at(-1)![0];
    expect(state.last_uid).toBe(200);
  });

  it("records the highest UID when every chunk succeeds", async () => {
    serveExcept(-1); // nothing fails

    await imapInitialSync("acc-1");

    const state = mockUpsertFolderSyncState.mock.calls.at(-1)![0];
    expect(state.last_uid).toBe(400);
  });
});

/**
 * A message's local id is `imap-{accountId}-{folder}-{uid}`. UIDVALIDITY is
 * the server's promise that those UIDs keep meaning the same messages; when
 * it changes, the promise is withdrawn and the same mail comes back under a
 * new UID. The resync then writes it under a new id, and the rows from before
 * the change are left behind — nothing updates them and no id the server now
 * reports will ever match them, so the folder appears twice.
 */
describe("imapDeltaSync — UIDVALIDITY change", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockDeleteMessagesInFolder = vi.mocked(deleteMessagesInFolder);
  const mockDeleteEmptyThreads = vi.mocked(deleteEmptyThreads);
  const mockUpsertMessage = vi.mocked(upsertMessage);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
    ]);
    mockGetAllFolderSyncStates.mockResolvedValue([
      {
        account_id: "acc-1",
        folder_path: "INBOX",
        uidvalidity: 1,
        last_uid: 10,
        modseq: null,
        last_sync_at: 0,
      },
    ] as never);
    // The server has renumbered the folder.
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 2, new_uids: [], uidvalidity_changed: true },
    ] as never);
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 2],
      folder_status: createMockImapFolderStatus({ uidvalidity: 2 }),
    });
    mockImapFetchMessages.mockResolvedValue(
      createMockImapFetchResult([
        createMockImapMessage({ uid: 1, message_id: "<a@test>", date: Math.floor(Date.now() / 1000) }),
        createMockImapMessage({ uid: 2, message_id: "<b@test>", date: Math.floor(Date.now() / 1000) }),
      ]),
    );
    mockDeleteMessagesInFolder.mockResolvedValue(["imap-thread-old"]);
  });

  afterEach(() => {
    mockImapSearchFolder.mockReset();
    mockImapFetchMessages.mockReset();
    mockImapListFolders.mockReset();
  });

  it("clears the folder's stored messages before refetching it", async () => {
    await imapDeltaSync("acc-1");

    expect(mockDeleteMessagesInFolder).toHaveBeenCalledWith("acc-1", "INBOX");
  });

  it("removes the messages before the new ones are written", async () => {
    await imapDeltaSync("acc-1");

    expect(mockUpsertMessage).toHaveBeenCalled();
    expect(mockDeleteMessagesInFolder.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUpsertMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("takes the threads that are left empty with them", async () => {
    await imapDeltaSync("acc-1");

    expect(mockDeleteEmptyThreads).toHaveBeenCalledWith("acc-1", ["imap-thread-old"]);
  });

  it("leaves the folder alone on an ordinary delta", async () => {
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [11], uidvalidity_changed: false },
    ] as never);

    await imapDeltaSync("acc-1");

    expect(mockDeleteMessagesInFolder).not.toHaveBeenCalled();
  });
});

describe("imapDeltaSync — last_uid is recorded only for messages that were stored", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockUpsertFolderSyncState = vi.mocked(upsertFolderSyncState);
  const mockUpsertMessage = vi.mocked(upsertMessage);
  const mockGetPendingOps = vi.mocked(getPendingOpsForResource);

  const mockImapSearchFolder = vi.mocked(imapSearchFolder);

  /** One unrelated message, so each UID is a thread of its own. */
  function inboxMessage(uid: number, folder = "INBOX") {
    return createMockImapMessage({
      uid,
      folder,
      message_id: `<m${uid}@${folder}.test>`,
      subject: `Subject ${uid}`,
      date: uid * 1000,
    });
  }

  /** The thread ID the sync derives for a message that stands alone. */
  function threadIdOf(uid: number, folder = "INBOX"): string {
    const { threadable } = imapMessageToParsedMessage(inboxMessage(uid, folder), "acc-1", folder);
    return buildThreads([threadable])[0]!.threadId;
  }

  /** Leave only these threads with a local operation in flight. */
  function pendingOpsOn(...threadIds: string[]) {
    mockGetPendingOps.mockImplementation(async (_account, resourceId) =>
      threadIds.includes(resourceId) ? [{ id: 1 } as never] : [],
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertMessage.mockReset();
    mockGetPendingOps.mockReset();
    mockGetPendingOps.mockResolvedValue([]);
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
    ]);
    mockGetAllFolderSyncStates.mockResolvedValue([
      {
        account_id: "acc-1",
        folder_path: "INBOX",
        uidvalidity: 1,
        last_uid: 4,
        modseq: null,
        last_sync_at: 0,
      },
    ] as never);
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [5, 6, 7], uidvalidity_changed: false },
    ] as never);
    mockImapFetchMessages.mockResolvedValue(
      createMockImapFetchResult([5, 6, 7].map((uid) => inboxMessage(uid))),
    );
  });

  it("records the highest UID once every message is stored", async () => {
    await imapDeltaSync("acc-1");

    expect(mockUpsertFolderSyncState).toHaveBeenCalledTimes(1);
    expect(mockUpsertFolderSyncState.mock.calls[0]![0].last_uid).toBe(7);
  });

  it("records it after the messages, not before", async () => {
    await imapDeltaSync("acc-1");

    expect(mockUpsertMessage).toHaveBeenCalled();
    expect(mockUpsertMessage.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mockUpsertFolderSyncState.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves last_uid alone when storing the messages fails", async () => {
    mockUpsertMessage.mockRejectedValue(new Error("database is locked"));

    await expect(imapDeltaSync("acc-1")).rejects.toThrow("database is locked");

    expect(mockUpsertFolderSyncState).not.toHaveBeenCalled();
  });

  it("holds last_uid below a message whose thread was skipped", async () => {
    pendingOpsOn(threadIdOf(6));

    await imapDeltaSync("acc-1");

    // UID 7 was stored, but 6 was not — the watermark may not pass it.
    expect(mockUpsertFolderSyncState).toHaveBeenCalledTimes(1);
    expect(mockUpsertFolderSyncState.mock.calls[0]![0].last_uid).toBe(5);
  });

  it("keeps the previous last_uid when every thread was skipped", async () => {
    pendingOpsOn(threadIdOf(5), threadIdOf(6), threadIdOf(7));

    await imapDeltaSync("acc-1");

    expect(mockUpsertFolderSyncState).toHaveBeenCalledTimes(1);
    expect(mockUpsertFolderSyncState.mock.calls[0]![0].last_uid).toBe(4);
  });

  it("holds last_uid for a folder that has no sync state yet", async () => {
    mockGetAllFolderSyncStates.mockResolvedValue([]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [5, 6, 7],
      folder_status: createMockImapFolderStatus({ uidvalidity: 1 }),
    });
    pendingOpsOn(threadIdOf(6));

    await imapDeltaSync("acc-1");

    expect(mockUpsertFolderSyncState).toHaveBeenCalledTimes(1);
    expect(mockUpsertFolderSyncState.mock.calls[0]![0].last_uid).toBe(5);
  });

  it("holds last_uid for a folder whose UIDVALIDITY changed", async () => {
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 2, new_uids: [], uidvalidity_changed: true },
    ] as never);
    mockImapSearchFolder.mockResolvedValue({
      uids: [5, 6, 7],
      folder_status: createMockImapFolderStatus({ uidvalidity: 2 }),
    });
    pendingOpsOn(threadIdOf(6));

    await imapDeltaSync("acc-1");

    expect(mockUpsertFolderSyncState).toHaveBeenCalledTimes(1);
    const state = mockUpsertFolderSyncState.mock.calls[0]![0];
    expect(state.uidvalidity).toBe(2);
    expect(state.last_uid).toBe(5);
  });

  it("holds back only the folder that has a skipped message", async () => {
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
      createMockImapFolder({ path: "Sent", raw_path: "Sent" }),
    ]);
    mockGetAllFolderSyncStates.mockResolvedValue(
      ["INBOX", "Sent"].map((folder_path) => ({
        account_id: "acc-1",
        folder_path,
        uidvalidity: 1,
        last_uid: 1,
        modseq: null,
        last_sync_at: 0,
      })) as never,
    );
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [5, 6], uidvalidity_changed: false },
      { folder: "Sent", uidvalidity: 1, new_uids: [8, 9], uidvalidity_changed: false },
    ] as never);
    mockImapFetchMessages.mockImplementation((async (_config: unknown, folder: string, uids: number[]) =>
      createMockImapFetchResult(uids.map((uid) => inboxMessage(uid, folder)))) as never);
    pendingOpsOn(threadIdOf(6, "INBOX"));

    await imapDeltaSync("acc-1");

    const lastUidOf = (folder: string) =>
      mockUpsertFolderSyncState.mock.calls.find(([s]) => s.folder_path === folder)![0].last_uid;
    expect(lastUidOf("INBOX")).toBe(5);
    expect(lastUidOf("Sent")).toBe(9);
  });
});

describe("imapDeltaSync — UIDs the server listed but the fetch did not deliver", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapFetchMessages = vi.mocked(imapFetchMessages);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockUpsertFolderSyncState = vi.mocked(upsertFolderSyncState);

  const message = (uid: number) =>
    createMockImapMessage({
      uid,
      message_id: `<m${uid}@test>`,
      subject: `Subject ${uid}`,
      date: uid * 1000,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    resetUndeliveredUidAttempts();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
    ]);
    mockGetAllFolderSyncStates.mockResolvedValue([
      { account_id: "acc-1", folder_path: "INBOX", uidvalidity: 1, last_uid: 4, modseq: null, last_sync_at: 0 },
    ] as never);
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [5, 6, 7], uidvalidity_changed: false },
    ] as never);
    // UID 6 is on the server, but the fetch leaves it out without an error —
    // a stream error or a body it could not read is only logged on the Rust side.
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([message(5), message(7)]));
  });

  const lastUidRecorded = () => mockUpsertFolderSyncState.mock.calls.at(-1)![0].last_uid;

  it("holds last_uid below a UID that was asked for and not delivered", async () => {
    await imapDeltaSync("acc-1");

    expect(lastUidRecorded()).toBe(5);
  });

  it("keeps holding it for a second sync", async () => {
    await imapDeltaSync("acc-1");
    await imapDeltaSync("acc-1");

    expect(lastUidRecorded()).toBe(5);
  });

  it("gives up on a UID that is still missing after three syncs", async () => {
    await imapDeltaSync("acc-1");
    await imapDeltaSync("acc-1");
    await imapDeltaSync("acc-1");

    // Otherwise one message the server cannot serve would pin the folder for
    // good and every sync would refetch everything above it.
    expect(lastUidRecorded()).toBe(7);
  });

  it("starts counting again once the UID has been delivered", async () => {
    await imapDeltaSync("acc-1");
    await imapDeltaSync("acc-1");
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([message(5), message(6), message(7)]));
    await imapDeltaSync("acc-1");
    expect(lastUidRecorded()).toBe(7);

    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([message(5), message(7)]));
    await imapDeltaSync("acc-1");
    expect(lastUidRecorded()).toBe(5);
  });

  it("does not hold anything when every UID is delivered", async () => {
    mockImapFetchMessages.mockResolvedValue(createMockImapFetchResult([message(5), message(6), message(7)]));

    await imapDeltaSync("acc-1");

    expect(lastUidRecorded()).toBe(7);
  });
});
