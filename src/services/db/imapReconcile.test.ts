import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();
vi.mock("./connection", () => ({
  getDb: vi.fn(() => ({
    execute: (...args: unknown[]) => mockExecute(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  })),
}));

import {
  getLocalMessagesInFolder,
  setMessageFlags,
  removeMessagesAndRefreshThreads,
  refreshThreadFlags,
} from "./imapReconcile";

const sqls = () => mockExecute.mock.calls.map(([sql]) => String(sql));

describe("db/imapReconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the stored messages of one folder", async () => {
    mockSelect.mockResolvedValue([]);
    await getLocalMessagesInFolder("acc-1", "INBOX");
    expect(mockSelect.mock.calls[0]![1]).toEqual(["acc-1", "INBOX"]);
  });

  it("writes the flags only while the row still has the expected ones", async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    const applied = await setMessageFlags(
      "acc-1",
      "m1",
      { isRead: false, isStarred: false },
      { isRead: true, isStarred: false },
    );
    expect(applied).toBe(true);
    expect(String(mockExecute.mock.calls[0]![0])).toContain("AND is_read = $5 AND is_starred = $6");
    expect(mockExecute.mock.calls[0]![1]).toEqual([1, 0, "acc-1", "m1", 0, 0]);
  });

  it("reports a row that changed in between as not written", async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 0 });
    const applied = await setMessageFlags(
      "acc-1",
      "m1",
      { isRead: false, isStarred: false },
      { isRead: true, isStarred: false },
    );
    expect(applied).toBe(false);
  });

  it("deletes the messages in chunks below SQLite's variable limit", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    await removeMessagesAndRefreshThreads("acc-1", "INBOX", "INBOX", ids, []);
    const deletes = mockExecute.mock.calls.filter(([sql]) => String(sql).startsWith("DELETE FROM messages"));
    expect(deletes).toHaveLength(3);
    expect(deletes[0]![1]).toHaveLength(501);
  });

  it("drops an emptied thread, recomputes the rest and removes the folder label", async () => {
    await removeMessagesAndRefreshThreads("acc-1", "INBOX", "INBOX", ["m1"], ["t1"]);
    const all = sqls().join("\n");
    expect(all).toContain("DELETE FROM threads");
    expect(all).toContain("UPDATE threads SET");
    const folderLabel = mockExecute.mock.calls.find(([, params]) => Array.isArray(params) && params.includes("INBOX") && params.length === 4);
    expect(folderLabel).toBeDefined();
  });

  it("recomputes thread flags without touching folder labels", async () => {
    await refreshThreadFlags("acc-1", "t1");
    expect(mockExecute.mock.calls.every(([, params]) => !(params as unknown[]).includes("INBOX"))).toBe(true);
  });
});
