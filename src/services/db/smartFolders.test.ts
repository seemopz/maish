import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
}));

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: mockGetDb,
    buildDynamicUpdate: vi.fn(),
    selectFirstBy: async (query: string, params: unknown[] = []) => {
      const db = await mockGetDb();
      const rows = await db.select(query, params);
      return rows[0] ?? null;
    },
  };
});

import { getDb, buildDynamicUpdate } from "@/services/db/connection";
import {
  getSmartFolders,
  insertSmartFolder,
  updateSmartFolder,
  deleteSmartFolder,
} from "./smartFolders";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("smartFolders service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(
      mockDb as unknown as Awaited<ReturnType<typeof getDb>>,
    );
  });

  describe("getSmartFolders", () => {
    it("returns global folders when no accountId", async () => {
      await getSmartFolders();

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("WHERE account_id IS NULL"),
      );
    });

    it("returns global + account folders when accountId provided", async () => {
      await getSmartFolders("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("account_id IS NULL OR account_id = $1"),
        ["acc-1"],
      );
    });

    it("orders by sort_order", async () => {
      await getSmartFolders("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY sort_order"),
        expect.anything(),
      );
    });
  });

  describe("insertSmartFolder", () => {
    it("inserts with all fields", async () => {
      const id = await insertSmartFolder({
        name: "Test Folder",
        query: "is:unread",
        accountId: "acc-1",
        icon: "Star",
        color: "#ff0000",
      });

      expect(id).toBeTruthy();
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO smart_folders"),
        expect.arrayContaining(["Test Folder", "is:unread", "acc-1", "Star", "#ff0000"]),
      );
    });

    it("inserts with defaults for optional fields", async () => {
      await insertSmartFolder({
        name: "Test",
        query: "from:boss",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO smart_folders"),
        expect.arrayContaining(["Test", "from:boss", null, "Search", null]),
      );
    });
  });

  describe("updateSmartFolder", () => {
    it("delegates to buildDynamicUpdate", async () => {
      vi.mocked(buildDynamicUpdate).mockReturnValue({
        sql: "UPDATE smart_folders SET name = $1 WHERE id = $2",
        params: ["New Name", "sf-1"],
      });

      await updateSmartFolder("sf-1", { name: "New Name" });

      expect(buildDynamicUpdate).toHaveBeenCalledWith(
        "smart_folders",
        "id",
        "sf-1",
        [["name", "New Name"]],
      );
      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE smart_folders SET name = $1 WHERE id = $2",
        ["New Name", "sf-1"],
      );
    });

    it("does nothing when no updates provided", async () => {
      vi.mocked(buildDynamicUpdate).mockReturnValue(null);

      await updateSmartFolder("sf-1", {});

      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  describe("deleteSmartFolder", () => {
    it("deletes by id", async () => {
      await deleteSmartFolder("sf-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM smart_folders WHERE id = $1",
        ["sf-1"],
      );
    });
  });
});
