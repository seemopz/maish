import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauriCommands", () => ({ imapFetchFlags: vi.fn() }));
vi.mock("../logFile", () => ({ logToFile: vi.fn() }));
vi.mock("../db/connection", () => ({
  withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
}));
vi.mock("../db/pendingOperations", () => ({
  getResourceIdsWithOpenOps: vi.fn(async () => new Set<string>()),
}));
vi.mock("../db/imapReconcile", () => ({
  getLocalMessagesInFolder: vi.fn(),
  setMessageFlags: vi.fn(),
  removeMessagesAndRefreshThreads: vi.fn(),
  refreshThreadFlags: vi.fn(),
}));

import { reconcileFolder, resetReconcileClock } from "./imapReconcile";
import { imapFetchFlags, type ImapConfig } from "./tauriCommands";
import { getResourceIdsWithOpenOps } from "../db/pendingOperations";
import {
  getLocalMessagesInFolder,
  setMessageFlags,
  removeMessagesAndRefreshThreads,
  refreshThreadFlags,
} from "../db/imapReconcile";

const config = { host: "imap.example.com" } as ImapConfig;
const args = {
  accountId: "acc-1",
  config,
  folderPath: "INBOX",
  folderLabelId: "INBOX",
  uidvalidity: 7,
};

function local(uid: number, over: Partial<{ thread_id: string; is_read: number; is_starred: number }> = {}) {
  return { id: `imap-acc-1-INBOX-${uid}`, thread_id: `t${uid}`, imap_uid: uid, is_read: 1, is_starred: 0, ...over };
}
function remote(uid: number, over: Partial<{ is_read: boolean; is_starred: boolean }> = {}) {
  return { uid, is_read: true, is_starred: false, ...over };
}

describe("reconcileFolder", () => {
  const mockFlags = vi.mocked(imapFetchFlags);
  const mockLocal = vi.mocked(getLocalMessagesInFolder);

  beforeEach(() => {
    vi.clearAllMocks();
    resetReconcileClock();
    vi.mocked(getResourceIdsWithOpenOps).mockResolvedValue(new Set());
    mockLocal.mockResolvedValue([local(3), local(4), local(5)]);
    mockFlags.mockResolvedValue({ uidvalidity: 7, messages: [remote(3), remote(4), remote(5)] });
  });

  it("asks the server from the lowest stored UID up", async () => {
    await reconcileFolder(args);

    expect(mockFlags).toHaveBeenCalledWith(config, "INBOX", "3:*");
  });

  it("takes over a read flag that changed on the server for an old message", async () => {
    mockLocal.mockResolvedValue([local(3, { is_read: 0 }), local(4)]);
    mockFlags.mockResolvedValue({ uidvalidity: 7, messages: [remote(3, { is_read: true }), remote(4)] });

    const result = await reconcileFolder(args);

    expect(setMessageFlags).toHaveBeenCalledWith("acc-1", "imap-acc-1-INBOX-3", true, false);
    expect(setMessageFlags).toHaveBeenCalledTimes(1);
    expect(refreshThreadFlags).toHaveBeenCalledWith("acc-1", "t3");
    expect(result).toEqual({ updated: 1, removed: 0 });
  });

  it("takes over a star that was set or removed on the server", async () => {
    mockLocal.mockResolvedValue([local(3), local(4, { is_starred: 1 })]);
    mockFlags.mockResolvedValue({
      uidvalidity: 7,
      messages: [remote(3, { is_starred: true }), remote(4, { is_starred: false })],
    });

    await reconcileFolder(args);

    expect(setMessageFlags).toHaveBeenCalledWith("acc-1", "imap-acc-1-INBOX-3", true, true);
    expect(setMessageFlags).toHaveBeenCalledWith("acc-1", "imap-acc-1-INBOX-4", true, false);
  });

  it("removes a message the server no longer lists and refreshes its thread", async () => {
    mockFlags.mockResolvedValue({ uidvalidity: 7, messages: [remote(3), remote(5)] });

    const result = await reconcileFolder(args);

    expect(removeMessagesAndRefreshThreads).toHaveBeenCalledWith(
      "acc-1",
      "INBOX",
      "INBOX",
      ["imap-acc-1-INBOX-4"],
      ["t4"],
    );
    expect(result).toEqual({ updated: 0, removed: 1 });
  });

  it("changes nothing when flags and UIDs agree", async () => {
    const result = await reconcileFolder(args);

    expect(setMessageFlags).not.toHaveBeenCalled();
    expect(removeMessagesAndRefreshThreads).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, removed: 0 });
  });

  it("leaves a thread alone while a local action on it is still queued", async () => {
    mockFlags.mockResolvedValue({ uidvalidity: 7, messages: [remote(3, { is_read: false }), remote(5)] });
    vi.mocked(getResourceIdsWithOpenOps).mockResolvedValue(new Set(["t3", "imap-acc-1-INBOX-4"]));

    const result = await reconcileFolder(args);

    expect(setMessageFlags).not.toHaveBeenCalled();
    expect(removeMessagesAndRefreshThreads).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, removed: 0 });
  });

  it("does nothing when the folder's UIDVALIDITY is no longer the stored one", async () => {
    mockFlags.mockResolvedValue({ uidvalidity: 8, messages: [] });

    const result = await reconcileFolder(args);

    expect(removeMessagesAndRefreshThreads).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, removed: 0 });
  });

  it("deletes nothing when the server list could not be fetched", async () => {
    mockFlags.mockRejectedValue(new Error("UID FETCH INBOX flags timed out after 120s"));

    await expect(reconcileFolder(args)).resolves.toEqual({ updated: 0, removed: 0 });
    expect(removeMessagesAndRefreshThreads).not.toHaveBeenCalled();
  });

  it("does not ask the server for a folder with no stored mail", async () => {
    mockLocal.mockResolvedValue([]);

    await reconcileFolder(args);

    expect(mockFlags).not.toHaveBeenCalled();
  });

  it("runs a folder only once per interval, but again after it", async () => {
    vi.useFakeTimers();
    try {
      await reconcileFolder(args);
      await reconcileFolder(args);
      expect(mockFlags).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(11 * 60_000);
      await reconcileFolder(args);
      expect(mockFlags).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed folder on the next sync instead of waiting out the interval", async () => {
    mockFlags.mockRejectedValueOnce(new Error("boom"));

    await reconcileFolder(args);
    await reconcileFolder(args);

    expect(mockFlags).toHaveBeenCalledTimes(2);
  });
});
