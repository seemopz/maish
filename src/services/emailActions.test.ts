import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dependencies
vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: vi.fn(() => ({ isOnline: true })),
  },
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: vi.fn(() => ({
      updateThread: vi.fn(),
      removeThread: vi.fn(),
    })),
  },
}));

vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/services/db/pendingOperations", () => ({
  enqueuePendingOperation: vi.fn(() => Promise.resolve("op-1")),
  deleteOperation: vi.fn(() => Promise.resolve()),
  holdOperation: vi.fn(() => Promise.resolve()),
}));

const { mockDbExecute, mockDbSelect } = vi.hoisted(() => ({
  mockDbExecute: vi.fn(() => Promise.resolve()),
  mockDbSelect: vi.fn(() => Promise.resolve([] as unknown[])),
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      execute: mockDbExecute,
      select: mockDbSelect,
    }),
  ),
}));

vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  getSelectedThreadId: vi.fn(() => null),
}));

import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation, deleteOperation, holdOperation } from "@/services/db/pendingOperations";
import {
  archiveThread,
  trashThread,
  permanentDeleteThread,
  starThread,
  markThreadRead,
  spamThread,
  moveThread,
  executeEmailAction,
  executeQueuedAction,
} from "./emailActions";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";
import { useUndoStore } from "@/stores/undoStore";
import { flushPendingUndo, undoPending, undoBatch } from "./undoableActions";
import { createMockEmailProvider, createMockUIStoreState, createMockThreadStoreState } from "@/test/mocks";

const mockProvider = createMockEmailProvider();

const mockUpdateThread = vi.fn();
const mockRemoveThread = vi.fn();

describe("emailActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect.mockResolvedValue([]);
    vi.mocked(getEmailProvider).mockResolvedValue(mockProvider as never);
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState() as never);
    vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
      updateThread: mockUpdateThread,
      removeThread: mockRemoveThread,
    }) as never);
  });

  describe("online execution", () => {
    it("archives a thread via provider", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"], { undo: false });
      expect(result.success).toBe(true);
      expect(result.queued).toBeUndefined();
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("trashes a thread via provider", async () => {
      const result = await trashThread("acct-1", "t1", ["m1"], { undo: false });
      expect(result.success).toBe(true);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("stars a thread via provider", async () => {
      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
      expect(mockProvider.star).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("marks thread read via provider", async () => {
      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: true });
      expect(mockProvider.markRead).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("reports spam via provider", async () => {
      const result = await spamThread("acct-1", "t1", ["m1"], true, { undo: false });
      expect(result.success).toBe(true);
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.spam).toHaveBeenCalledWith("t1", ["m1"], true);
    });
  });

  describe("offline queueing", () => {
    beforeEach(() => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
    });

    it("queues archive when offline", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"], { undo: false });
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(mockProvider.archive).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
      );
    });

    it("still applies optimistic UI update when offline", async () => {
      await starThread("acct-1", "t1", ["m1"], true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
    });
  });

  describe("network error → queue fallback", () => {
    it("queues on retryable network error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.archive.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await archiveThread("acct-1", "t1", ["m1"], { undo: false });
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(enqueuePendingOperation).toHaveBeenCalled();
    });
  });

  describe("permanent error → revert", () => {
    it("reverts star on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.star.mockRejectedValueOnce(new Error("Invalid request"));

      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // Revert: set starred to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: false });
    });

    it("reverts markRead on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.markRead.mockRejectedValueOnce(new Error("Bad request"));

      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      // Revert: set read to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: false });
    });
  });

  describe("auto-advance after removal", () => {
    const threads = [
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ];

    it("navigates to next thread when archiving the viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates to previous thread when archiving the last thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t3");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t3", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("does not navigate when archiving a non-viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
    });

    it("does not navigate when archiving the only thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads: [{ id: "t1" }],
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
    });

    it("navigates on trash action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await trashThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on spam action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await spamThread("acct-1", "t1", ["m1"], true);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on permanentDelete action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await permanentDeleteThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates on moveToFolder action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await moveThread("acct-1", "t2", ["m1"], "Archive");
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });
  });

  describe("executeEmailAction with draft actions", () => {
    it("sends a message via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "sendMessage",
        rawBase64Url: "base64data",
        threadId: "t1",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.sendMessage).toHaveBeenCalledWith("base64data", "t1");
    });

    it("creates a draft via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "createDraft",
        rawBase64Url: "base64data",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.createDraft).toHaveBeenCalledWith("base64data", undefined);
    });
  });

  describe("message ID resolution", () => {
    // Callers pass an empty messageIds array and expect the thread's messages to
    // be looked up here. Without that, IMAP providers group an empty list by
    // folder and never touch the server.
    const rows = [
      { id: "imap-acct-1-INBOX-100" },
      { id: "imap-acct-1-INBOX-200" },
    ];

    it("resolves the thread's message IDs when the caller passes none", async () => {
      mockDbSelect.mockResolvedValue(rows);

      await archiveThread("acct-1", "t1", [], { undo: false });

      expect(mockProvider.archive).toHaveBeenCalledWith("t1", [
        "imap-acct-1-INBOX-100",
        "imap-acct-1-INBOX-200",
      ]);
    });

    it("resolves for every action that carries message IDs", async () => {
      mockDbSelect.mockResolvedValue(rows);
      const ids = ["imap-acct-1-INBOX-100", "imap-acct-1-INBOX-200"];

      await trashThread("acct-1", "t1", [], { undo: false });
      await starThread("acct-1", "t1", [], true);
      await markThreadRead("acct-1", "t1", [], true);
      await spamThread("acct-1", "t1", [], true, { undo: false });
      await moveThread("acct-1", "t1", [], "Work", { undo: false });

      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ids);
      expect(mockProvider.star).toHaveBeenCalledWith("t1", ids, true);
      expect(mockProvider.markRead).toHaveBeenCalledWith("t1", ids, true);
      expect(mockProvider.spam).toHaveBeenCalledWith("t1", ids, true);
      expect(mockProvider.moveToFolder).toHaveBeenCalledWith("t1", ids, "Work");
    });

    it("keeps message IDs the caller supplied", async () => {
      mockDbSelect.mockResolvedValue(rows);

      await archiveThread("acct-1", "t1", ["m1"], { undo: false });

      expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
      expect(mockDbSelect).not.toHaveBeenCalled();
    });

    it("resolves before the local DB update, so permanent delete still reaches the server", async () => {
      // applyLocalDbUpdate deletes the thread, and messages cascade with it —
      // the lookup has to happen first or there is nothing left to resolve.
      mockDbSelect.mockResolvedValue(rows);

      await permanentDeleteThread("acct-1", "t1", []);

      expect(mockProvider.permanentDelete).toHaveBeenCalledWith("t1", [
        "imap-acct-1-INBOX-100",
        "imap-acct-1-INBOX-200",
      ]);
      expect(mockDbSelect.mock.invocationCallOrder[0]!).toBeLessThan(
        mockDbExecute.mock.invocationCallOrder[0]!,
      );
    });

    it("queues the resolved IDs when offline", async () => {
      mockDbSelect.mockResolvedValue(rows);
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);

      await archiveThread("acct-1", "t1", [], { undo: false });

      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({
          messageIds: ["imap-acct-1-INBOX-100", "imap-acct-1-INBOX-200"],
        }),
      );
    });

    it("resolves for operations queued before this fix", async () => {
      mockDbSelect.mockResolvedValue(rows);

      await executeQueuedAction("acct-1", "archive", {
        threadId: "t1",
        messageIds: [],
      });

      expect(mockProvider.archive).toHaveBeenCalledWith("t1", [
        "imap-acct-1-INBOX-100",
        "imap-acct-1-INBOX-200",
      ]);
    });

    it("falls back to an empty list when the lookup fails", async () => {
      mockDbSelect.mockRejectedValue(new Error("db gone"));

      const result = await archiveThread("acct-1", "t1", [], { undo: false });

      expect(result.success).toBe(true);
      expect(mockProvider.archive).toHaveBeenCalledWith("t1", []);
    });
  });
});

describe("emailActions undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({ isOnline: true }));
    vi.mocked(useThreadStore.getState).mockReturnValue(
      createMockThreadStoreState({ updateThread: mockUpdateThread, removeThread: mockRemoveThread }),
    );
    vi.mocked(getEmailProvider).mockResolvedValue(mockProvider);
    mockDbSelect.mockResolvedValue([]);
  });

  afterEach(async () => {
    await flushPendingUndo();
  });

  it("applies the change locally but holds the server call during the undo window", async () => {
    const result = await archiveThread("acct-1", "t1", ["m1"]);

    expect(result.success).toBe(true);
    expect(mockRemoveThread).toHaveBeenCalledWith("t1");
    expect(mockProvider.archive).not.toHaveBeenCalled();
    expect(useUndoStore.getState().message).toBe("Conversation archived");
  });

  it("stores the call in the queue at once, delayed past the window, so a quit loses nothing", async () => {
    await archiveThread("acct-1", "t1", ["m1"]);

    expect(enqueuePendingOperation).toHaveBeenCalledWith(
      "acct-1",
      "archive",
      "t1",
      { threadId: "t1", messageIds: ["m1"] },
      6,
    );
  });

  it("sends the call after the window and removes the queued copy", async () => {
    await archiveThread("acct-1", "t1", ["m1"]);
    await flushPendingUndo();

    expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    expect(holdOperation).toHaveBeenCalledWith("op-1", 60);
    expect(deleteOperation).toHaveBeenCalledWith("op-1");
  });

  it("leaves the queued copy to the processor while offline", async () => {
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({ isOnline: false }));
    await trashThread("acct-1", "t1", ["m1"]);

    await flushPendingUndo();

    expect(mockProvider.trash).not.toHaveBeenCalled();
    expect(holdOperation).toHaveBeenCalledWith("op-1", 0);
    expect(deleteOperation).not.toHaveBeenCalled();
  });

  it("releases the queued copy again on a retryable error", async () => {
    mockProvider.archive.mockRejectedValueOnce(new Error("network error"));
    await archiveThread("acct-1", "t1", ["m1"]);

    await flushPendingUndo();

    expect(holdOperation).toHaveBeenLastCalledWith("op-1", 0);
    expect(deleteOperation).not.toHaveBeenCalled();
  });

  it("sends at once when it cannot be queued", async () => {
    vi.mocked(enqueuePendingOperation).mockRejectedValueOnce(new Error("db locked"));

    await archiveThread("acct-1", "t1", ["m1"]);

    expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    expect(useUndoStore.getState().message).toBeNull();
  });

  it("undo takes the call out of the queue and sends nothing", async () => {
    await archiveThread("acct-1", "t1", ["m1"]);
    await undoPending();
    await flushPendingUndo();

    expect(deleteOperation).toHaveBeenCalledWith("op-1");
    expect(mockProvider.archive).not.toHaveBeenCalled();
  });

  it("undo of a multi-select takes back every thread", async () => {
    await undoBatch(async () => {
      await archiveThread("acct-1", "t1", ["m1"]);
      await archiveThread("acct-1", "t2", ["m2"]);
    });
    expect(useUndoStore.getState().message).toBe("2 conversations archived");

    await undoPending();
    await flushPendingUndo();
    expect(deleteOperation).toHaveBeenCalledTimes(2);
    expect(mockProvider.archive).not.toHaveBeenCalled();
  });

  it("undo of archive puts back the labels the thread had, and no others", async () => {
    mockDbSelect.mockResolvedValue([{ label_id: "STARRED" }]);
    await archiveThread("acct-1", "t1", ["m1"]);
    mockDbExecute.mockClear();

    await undoPending();

    const sql = mockDbExecute.mock.calls.map((c) => (c as unknown[])[0] as string).join("\n");
    expect(mockDbExecute).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE"), [
      "acct-1",
      "t1",
      "STARRED",
    ]);
    expect(mockDbExecute).not.toHaveBeenCalledWith(expect.anything(), ["acct-1", "t1", "INBOX"]);
    expect(sql).not.toContain("DELETE");
  });

  it("undo of trash restores INBOX and drops TRASH", async () => {
    mockDbSelect.mockResolvedValue([{ label_id: "INBOX" }]);
    await trashThread("acct-1", "t1", ["m1"]);
    mockDbExecute.mockClear();

    await undoPending();

    expect(mockDbExecute).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE"), [
      "acct-1",
      "t1",
      "INBOX",
    ]);
    expect(mockDbExecute).toHaveBeenCalledWith(expect.stringContaining("DELETE"), [
      "acct-1",
      "t1",
      "TRASH",
    ]);
  });

  it("raises no toast and sends at once with undo: false", async () => {
    await archiveThread("acct-1", "t1", ["m1"], { undo: false });

    expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    expect(useUndoStore.getState().message).toBeNull();
  });
});
