import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import {
  enqueuePendingOperation,
  getPendingOperations,
  updateOperationStatus,
  deleteOperation,
  claimOperation,
  releaseOperation,
  releaseExecutingOperations,
  deleteUnclaimedOperation,
  incrementRetry,
  getPendingOpsCount,
  getFailedOpsCount,
  getPendingOpsForResource,
  compactQueue,
  clearFailedOperations,
  retryFailedOperations,
} from "./pendingOperations";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("pendingOperations DB service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(
      mockDb as unknown as Awaited<ReturnType<typeof getDb>>,
    );
  });

  describe("enqueuePendingOperation", () => {
    it("inserts a new operation with UUID", async () => {
      const id = await enqueuePendingOperation("acct-1", "archive", "thread-1", { messageIds: ["m1"] });
      expect(id).toBeTruthy();
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO pending_operations"),
        expect.arrayContaining(["acct-1", "archive", "thread-1"]),
      );
    });
  });

  describe("delayed operations", () => {
    it("enqueues with no retry time by default", async () => {
      await enqueuePendingOperation("acct-1", "archive", "thread-1", {});
      const args = mockDb.execute.mock.calls.at(-1)![1] as unknown[];
      expect(args[5]).toBeNull();
    });

    it("enqueues with a retry time `delaySec` seconds ahead", async () => {
      const before = Math.floor(Date.now() / 1000);
      await enqueuePendingOperation("acct-1", "archive", "thread-1", {}, 6);
      const args = mockDb.execute.mock.calls.at(-1)![1] as unknown[];
      expect(args[5]).toBeGreaterThanOrEqual(before + 6);
      expect(args[5]).toBeLessThanOrEqual(before + 8);
    });

    it("claimOperation only takes a pending row and reports whether it won", async () => {
      expect(await claimOperation("op-1")).toBe(true);
      expect(mockDb.execute).toHaveBeenLastCalledWith(
        expect.stringContaining("status = 'pending'"),
        ["op-1"],
      );
      mockDb.execute.mockResolvedValueOnce({ rowsAffected: 0 });
      expect(await claimOperation("op-1")).toBe(false);
    });

    it("releaseOperation puts the row back without a retry time", async () => {
      await releaseOperation("op-1");
      expect(mockDb.execute).toHaveBeenLastCalledWith(
        expect.stringContaining("next_retry_at = NULL"),
        ["op-1"],
      );
    });

    it("deleteUnclaimedOperation reports false once the row is on its way", async () => {
      expect(await deleteUnclaimedOperation("op-1")).toBe(true);
      expect(mockDb.execute).toHaveBeenLastCalledWith(
        expect.stringContaining("status = 'pending'"),
        ["op-1"],
      );
      mockDb.execute.mockResolvedValueOnce({ rowsAffected: 0 });
      expect(await deleteUnclaimedOperation("op-1")).toBe(false);
    });
  });

  describe("getPendingOperations", () => {
    it("fetches pending ops for a specific account", async () => {
      await getPendingOperations("acct-1");
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("account_id = $1"),
        expect.arrayContaining(["acct-1"]),
      );
    });

    it("fetches all pending ops when no account specified", async () => {
      await getPendingOperations();
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending'"),
        expect.not.arrayContaining(["acct-1"]),
      );
    });
  });

  describe("updateOperationStatus", () => {
    it("updates the status and error message", async () => {
      await updateOperationStatus("op-1", "failed", "Network timeout");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE pending_operations SET status"),
        ["failed", "Network timeout", "op-1"],
      );
    });

    it("sets error_message to null when not provided", async () => {
      await updateOperationStatus("op-1", "pending");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.any(String),
        ["pending", null, "op-1"],
      );
    });
  });

  describe("deleteOperation", () => {
    it("deletes by id", async () => {
      await deleteOperation("op-1");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM pending_operations WHERE id"),
        ["op-1"],
      );
    });
  });

  describe("releaseExecutingOperations", () => {
    it("turns every executing row back into pending", async () => {
      await releaseExecutingOperations();
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending' WHERE status = 'executing'"),
      );
    });
  });

  describe("incrementRetry", () => {
    it("increments retry count with exponential backoff", async () => {
      mockDb.select.mockResolvedValueOnce([{ retry_count: 0, max_retries: 10 }]);
      await incrementRetry("op-1");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("retry_count = $1"),
        expect.arrayContaining([1]),
      );
    });

    it("requeues the claimed row together with the backoff", async () => {
      mockDb.select.mockResolvedValueOnce([{ retry_count: 0, max_retries: 10 }]);
      await incrementRetry("op-1");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'pending'"),
        expect.anything(),
      );
    });

    it("marks as failed when max retries reached", async () => {
      mockDb.select.mockResolvedValueOnce([{ retry_count: 9, max_retries: 10 }]);
      await incrementRetry("op-1");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        [10, "op-1"],
      );
    });

    it("does nothing if operation not found", async () => {
      mockDb.select.mockResolvedValueOnce([]);
      await incrementRetry("nonexistent");
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  describe("getPendingOpsCount", () => {
    it("returns count for specific account", async () => {
      mockDb.select.mockResolvedValueOnce([{ count: 5 }]);
      const count = await getPendingOpsCount("acct-1");
      expect(count).toBe(5);
    });

    it("returns global count", async () => {
      mockDb.select.mockResolvedValueOnce([{ count: 12 }]);
      const count = await getPendingOpsCount();
      expect(count).toBe(12);
    });
  });

  describe("getFailedOpsCount", () => {
    it("returns count of failed operations", async () => {
      mockDb.select.mockResolvedValueOnce([{ count: 3 }]);
      const count = await getFailedOpsCount();
      expect(count).toBe(3);
    });
  });

  describe("getPendingOpsForResource", () => {
    it("queries by account and resource", async () => {
      await getPendingOpsForResource("acct-1", "thread-1");
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("resource_id = $2"),
        ["acct-1", "thread-1"],
      );
    });
  });

  describe("compactQueue", () => {
    it("removes cancelling star toggle pairs", async () => {
      mockDb.select.mockResolvedValueOnce([
        { id: "op-1", account_id: "a1", resource_id: "t1", operation_type: "star", params: '{"starred":true}', status: "pending", created_at: 1 },
        { id: "op-2", account_id: "a1", resource_id: "t1", operation_type: "star", params: '{"starred":false}', status: "pending", created_at: 2 },
      ]);
      const removed = await compactQueue();
      expect(removed).toBe(2);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE"),
        expect.arrayContaining(["op-1", "op-2"]),
      );
    });

    it("removes cancelling addLabel+removeLabel pairs", async () => {
      mockDb.select.mockResolvedValueOnce([
        { id: "op-1", account_id: "a1", resource_id: "t1", operation_type: "addLabel", params: '{"labelId":"L1"}', status: "pending", created_at: 1 },
        { id: "op-2", account_id: "a1", resource_id: "t1", operation_type: "removeLabel", params: '{"labelId":"L1"}', status: "pending", created_at: 2 },
      ]);
      const removed = await compactQueue();
      expect(removed).toBe(2);
    });

    it("collapses sequential moves keeping only the latest", async () => {
      mockDb.select.mockResolvedValueOnce([
        { id: "op-1", account_id: "a1", resource_id: "t1", operation_type: "moveToFolder", params: '{"folderPath":"Folder1"}', status: "pending", created_at: 1 },
        { id: "op-2", account_id: "a1", resource_id: "t1", operation_type: "moveToFolder", params: '{"folderPath":"Folder2"}', status: "pending", created_at: 2 },
      ]);
      const removed = await compactQueue();
      expect(removed).toBe(1);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE"),
        ["op-1"],
      );
    });

    it("returns 0 when nothing to compact", async () => {
      mockDb.select.mockResolvedValueOnce([]);
      const removed = await compactQueue();
      expect(removed).toBe(0);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  describe("clearFailedOperations", () => {
    it("deletes all failed ops", async () => {
      await clearFailedOperations();
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM pending_operations WHERE status = 'failed'"),
      );
    });

    it("deletes failed ops for specific account", async () => {
      await clearFailedOperations("acct-1");
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("account_id = $1"),
        ["acct-1"],
      );
    });
  });

  describe("retryFailedOperations", () => {
    it("resets failed ops to pending", async () => {
      await retryFailedOperations();
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'pending'"),
      );
    });
  });
});
