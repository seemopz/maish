import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all dependencies before importing the module under test
vi.mock("./tokenManager", () => ({
  getGmailClient: vi.fn(),
}));
vi.mock("./sync", () => ({
  initialSync: vi.fn(),
  deltaSync: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  clearAccountHistoryId: vi.fn(),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("365"),
}));
vi.mock("../db/threads", () => ({
  getThreadCountForAccount: vi.fn(),
  deleteAllThreadsForAccount: vi.fn(),
}));
vi.mock("../db/messages", () => ({
  deleteAllMessagesForAccount: vi.fn(),
}));
vi.mock("../imap/imapSync", () => ({
  imapInitialSync: vi.fn(),
  imapDeltaSync: vi.fn(),
}));
vi.mock("../db/folderSyncState", () => ({
  clearAllFolderSyncStates: vi.fn(),
}));
vi.mock("../oauth/oauthTokenManager", () => ({
  ensureFreshToken: vi.fn(),
}));
vi.mock("../calendar/providerFactory", () => ({
  hasCalendarSupport: vi.fn().mockResolvedValue(false),
  getCalendarProvider: vi.fn(),
}));
vi.mock("../db/calendars", () => ({
  getVisibleCalendars: vi.fn().mockResolvedValue([]),
  upsertCalendar: vi.fn(),
  updateCalendarSyncToken: vi.fn(),
}));
vi.mock("../db/calendarEvents", () => ({
  upsertCalendarEvent: vi.fn(),
  deleteEventByRemoteId: vi.fn(),
}));

vi.mock("../logFile", () => ({
  logToFile: vi.fn(),
}));

// Import after mocks
import {
  syncAccount,
  startBackgroundSync,
  stopBackgroundSync,
  triggerSync,
  forceFullSync,
  resyncAccount,
  removeAccountFromSync,
  onSyncStatus,
} from "./syncManager";
import { getAccount, clearAccountHistoryId } from "../db/accounts";
import { deleteAllThreadsForAccount } from "../db/threads";
import { deleteAllMessagesForAccount } from "../db/messages";
import { clearAllFolderSyncStates } from "../db/folderSyncState";
import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync } from "./sync";
import { logToFile } from "../logFile";

const mockGetAccount = vi.mocked(getAccount);
const mockGetGmailClient = vi.mocked(getGmailClient);
const mockInitialSync = vi.mocked(initialSync);
const mockDeltaSync = vi.mocked(deltaSync);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeGmailAccount(id: string, historyId: string | null = null) {
  return {
    id,
    email: `${id}@gmail.com`,
    display_name: id,
    avatar_url: null,
    is_active: 1,
    provider: "gmail_api" as const,
    history_id: historyId,
    refresh_token: "tok",
    access_token: "tok",
    token_expiry: Date.now() + 60_000,
    client_id: "cid",
    client_secret: null,
    created_at: new Date().toISOString(),
    imap_host: null,
    imap_port: null,
    imap_security: null,
    smtp_host: null,
    smtp_port: null,
    smtp_security: null,
    auth_method: null,
    imap_password: null,
    imap_username: null,
  };
}

describe("syncManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopBackgroundSync();
    mockGetGmailClient.mockResolvedValue(
      {} as ReturnType<typeof getGmailClient> extends Promise<infer T>
        ? T
        : never,
    );
    mockInitialSync.mockResolvedValue();
    mockDeltaSync.mockResolvedValue();
  });

  afterEach(() => {
    stopBackgroundSync();
  });

  describe("syncAccount", () => {
    it("runs initial sync for an account without history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1"));

      await syncAccount("a1");

      expect(mockInitialSync).toHaveBeenCalledTimes(1);
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("runs delta sync for an account with history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "12345"));

      await syncAccount("a1");

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
      expect(mockInitialSync).not.toHaveBeenCalled();
    });

    it("queues a second account while sync is in progress", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      // Make first sync slow
      const barrier = new Promise<void>((r) => {
        // Resolve after 50ms
        setTimeout(r, 50);
      });
      let firstCall = true;
      mockDeltaSync.mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return barrier;
        }
        return Promise.resolve();
      });

      const first = syncAccount("a1");
      // a2 will be queued since a1 is in progress
      const second = syncAccount("a2");

      await first;
      await second;

      // Both accounts synced (a1 directly, a2 via queue drain)
      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("startBackgroundSync", () => {
    it("triggers an immediate sync by default", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));

      startBackgroundSync(["a1"]);

      // Wait for async sync chain to complete
      await wait(50);

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
    });

    it("skips immediate sync when skipImmediateSync is true", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));

      startBackgroundSync(["a1"], true);

      // Wait — no sync should have fired (next interval is 15s away)
      await wait(50);

      expect(mockDeltaSync).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
    });
  });

  describe("removeAccountFromSync", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops the periodic sync from touching a removed account", async () => {
      // Only the interval is faked — the sync itself still awaits real timers.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id, "100"));

      startBackgroundSync(["keep", "gone"], true);
      removeAccountFromSync("gone");
      vi.advanceTimersByTime(60_000);
      await wait(50);

      expect(mockGetAccount).toHaveBeenCalledWith("keep");
      expect(mockGetAccount).not.toHaveBeenCalledWith("gone");
    });

    it("drops a removed account from the queued sync", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id, "100"));
      let release: () => void = () => {};
      mockDeltaSync.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));

      const first = syncAccount("a1");
      await wait(10);
      const queued = syncAccount("gone");
      removeAccountFromSync("gone");
      release();
      await first;
      await queued;

      expect(mockGetAccount).not.toHaveBeenCalledWith("gone");
    });

    it("reports 'removed' instead of an error when the account no longer exists", async () => {
      mockGetAccount.mockResolvedValue(null);
      const cb = vi.fn();
      const unsub = onSyncStatus(cb);

      await syncAccount("gone");
      unsub();

      expect(cb).toHaveBeenCalledWith("gone", "removed");
      expect(cb).not.toHaveBeenCalledWith("gone", "error", undefined, expect.anything());
    });

    it("does not end in 'error' when the account is deleted while its sync runs", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("gone-running", "100"));
      let fail: (e: Error) => void = () => {};
      mockDeltaSync.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
      const events: string[] = [];
      const unsub = onSyncStatus((_id, status) => { events.push(status); });

      const running = syncAccount("gone-running");
      await wait(10);
      removeAccountFromSync("gone-running");
      fail(new Error("Account not found"));
      await running;
      unsub();

      expect(events).toEqual(["syncing", "removed"]);
    });

    it("stays silent about a removed account's late progress", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("gone-late"));
      let finish: () => void = () => {};
      mockInitialSync.mockImplementationOnce((_client, _id, _days, onProgress) => new Promise<void>((resolve) => {
        finish = () => {
          onProgress?.({ phase: "messages", current: 1, total: 2 });
          resolve();
        };
      }));
      const events: string[] = [];
      const unsub = onSyncStatus((_id, status) => { events.push(status); });

      const running = syncAccount("gone-late");
      await wait(10);
      removeAccountFromSync("gone-late");
      finish();
      await running;
      unsub();

      expect(events).toEqual(["syncing", "removed"]);
    });

    it("tells the status listener so a remembered error can be dropped", () => {
      const cb = vi.fn();
      const unsub = onSyncStatus(cb);

      removeAccountFromSync("gone");
      unsub();

      expect(cb).toHaveBeenCalledWith("gone", "removed");
    });
  });

  describe("new account sync priority", () => {
    it("new account syncs immediately when background sync skips immediate run", async () => {
      const existingAccount = makeGmailAccount("existing", "100");
      const newAccount = makeGmailAccount("new-acc");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "existing") return existingAccount;
        if (id === "new-acc") return newAccount;
        return null;
      });

      // Simulate the fix: sync new account first, then start background with skipImmediate
      const syncPromise = syncAccount("new-acc");
      startBackgroundSync(["existing", "new-acc"], true);

      await syncPromise;

      // The new account got an initial sync immediately
      expect(mockInitialSync).toHaveBeenCalledTimes(1);
      // No delta sync ran (background timer hasn't fired)
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("without the fix, new account sync would be blocked by existing account sync", async () => {
      const existingAccount = makeGmailAccount("existing", "100");
      const newAccount = makeGmailAccount("new-acc");

      // Track the order of sync calls
      const syncOrder: string[] = [];

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "existing") return existingAccount;
        if (id === "new-acc") return newAccount;
        return null;
      });

      mockDeltaSync.mockImplementation(async () => {
        syncOrder.push("delta-existing");
      });
      mockInitialSync.mockImplementation(async () => {
        syncOrder.push("initial-new");
      });

      // Old behavior: startBackgroundSync first (with immediate sync), then syncAccount
      // This would queue new-acc behind existing account's delta sync
      startBackgroundSync(["existing", "new-acc"]);

      // Wait for both to complete
      await wait(50);

      // existing account's delta sync ran BEFORE new account's initial sync
      expect(syncOrder).toEqual(["delta-existing", "initial-new"]);
    });
  });

  describe("triggerSync", () => {
    it("syncs all provided accounts", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      await triggerSync(["a1", "a2"]);

      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("error coercion", () => {
    it("propagates plain string errors from Tauri IPC (not 'Unknown error')", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      // Tauri IPC rejects with a plain string, not an Error instance
      mockDeltaSync.mockRejectedValue("authentication failed for user@test.com");

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("authentication failed for user@test.com");
      expect(errors[0]).not.toBe("Unknown error");
    });

    it("handles null/undefined errors gracefully", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      mockDeltaSync.mockRejectedValue(null);

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("Unknown error");
    });
  });
  describe("resync outcome", () => {
    it("resyncAccount rejects with the sync error instead of resolving as done", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("r1"));
      mockInitialSync.mockRejectedValue(new Error("connection timed out"));

      await expect(resyncAccount("r1")).rejects.toThrow("connection timed out");
    });

    it("resyncAccount resolves when the sync works", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("r2"));

      await expect(resyncAccount("r2")).resolves.toBeUndefined();
    });

    it("a later success does not inherit an earlier failure", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("r3"));
      mockInitialSync.mockRejectedValueOnce(new Error("boom"));
      await expect(resyncAccount("r3")).rejects.toThrow("boom");

      await expect(resyncAccount("r3")).resolves.toBeUndefined();
    });

    it("forceFullSync rejects when any account fails and names the failure", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id));
      mockInitialSync.mockImplementation(async (_client, accountId) => {
        if (accountId === "bad") throw new Error("authentication failed");
      });

      await expect(forceFullSync(["good", "bad"])).rejects.toThrow("authentication failed");
    });

    it("triggerSync stays non-throwing", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("t1"));
      mockInitialSync.mockRejectedValue(new Error("boom"));

      await expect(triggerSync(["t1"])).resolves.toBeUndefined();
    });

    it("reports 'queued' while another sync runs, then waits for the real result", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id));
      let release: () => void = () => {};
      mockInitialSync.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      mockInitialSync.mockRejectedValueOnce(new Error("resync failed"));

      const background = syncAccount("bg");
      await wait(10);
      const onQueued = vi.fn();
      const resync = resyncAccount("rq", { onQueued });
      const settled = vi.fn();
      resync.catch(settled);
      await wait(10);

      expect(onQueued).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();

      release();
      await background;
      await expect(resync).rejects.toThrow("resync failed");
    });

    it("resyncAccount wipes only after the in-flight sync of that account has finished", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id, "100"));
      const order: string[] = [];
      let release: () => void = () => {};
      mockDeltaSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = () => { order.push("background-done"); resolve(); };
      }));
      vi.mocked(deleteAllThreadsForAccount).mockImplementationOnce(async () => { order.push("wipe"); });

      const background = syncAccount("w1");
      await wait(10);
      const resync = resyncAccount("w1");
      await wait(10);

      expect(deleteAllThreadsForAccount).not.toHaveBeenCalled();
      expect(clearAccountHistoryId).not.toHaveBeenCalled();

      release();
      await background;
      await resync;

      expect(order).toEqual(["background-done", "wipe"]);
      expect(deleteAllMessagesForAccount).toHaveBeenCalledWith("w1");
      expect(clearAllFolderSyncStates).toHaveBeenCalledWith("w1");
    });

    it("forceFullSync clears the history id only after the in-flight sync has finished", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id, "100"));
      let release: () => void = () => {};
      mockDeltaSync.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

      const background = syncAccount("w2");
      await wait(10);
      const full = forceFullSync(["w2"]);
      await wait(10);

      expect(clearAccountHistoryId).not.toHaveBeenCalled();

      release();
      await background;
      await full;

      expect(clearAccountHistoryId).toHaveBeenCalledWith("w2");
    });

    it("a failing wipe fails the resync and skips the sync", async () => {
      mockGetAccount.mockImplementation(async (id: string) => makeGmailAccount(id));
      vi.mocked(deleteAllThreadsForAccount).mockRejectedValueOnce(new Error("disk full"));

      await expect(resyncAccount("w3")).rejects.toThrow("disk full");
      expect(mockInitialSync).not.toHaveBeenCalled();
    });

    it("does not call onQueued when nothing else runs", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("nq"));
      const onQueued = vi.fn();

      await resyncAccount("nq", { onQueued });

      expect(onQueued).not.toHaveBeenCalled();
    });
  });

  describe("log file", () => {
    it("writes a failed sync to the log file", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("l1", "100"));
      mockDeltaSync.mockRejectedValue(new Error("imap timeout"));

      await syncAccount("l1");

      expect(logToFile).toHaveBeenCalledWith("error", expect.stringContaining("l1"));
      expect(logToFile).toHaveBeenCalledWith("error", expect.stringContaining("imap timeout"));
    });

    it("notifies every listener, not just the last one", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("m1"));
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = onSyncStatus(a);
      const unsubB = onSyncStatus(b);

      await syncAccount("m1");
      unsubA();
      unsubB();

      expect(a).toHaveBeenCalledWith("m1", "done");
      expect(b).toHaveBeenCalledWith("m1", "done");
    });
  });
});
