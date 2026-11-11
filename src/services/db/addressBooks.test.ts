import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
}));

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: mockGetDb,
    // The real helper closes over connection.ts's own getDb, so it has to be
    // routed through the mock as well or it opens a database in the test run.
    selectFirstBy: async (query: string, params: unknown[] = []) => {
      const db = await mockGetDb();
      const rows = await db.select(query, params);
      return rows[0] ?? null;
    },
  };
});

import { getDb } from "@/services/db/connection";
import {
  getAddressBooksForAccount,
  getVisibleAddressBooks,
  setAddressBookVisibility,
  updateAddressBookSyncState,
  upsertAddressBook,
} from "./addressBooks";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

const book = {
  accountId: "acc-1",
  provider: "carddav",
  remoteId: "https://dav.example.org/books/default/",
  displayName: "Kontakte",
  description: null,
  isReadOnly: false,
};

describe("address books service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  describe("upsertAddressBook", () => {
    it("inserts on the account and remote id pair", async () => {
      mockDb.select.mockResolvedValueOnce([{ id: "book-1" }] as never);

      await upsertAddressBook(book);

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT(account_id, remote_id) DO UPDATE"),
        expect.arrayContaining(["acc-1", "https://dav.example.org/books/default/"]),
      );
    });

    it("returns the id the row already had rather than the one it offered", async () => {
      mockDb.select.mockResolvedValueOnce([{ id: "existing-book" }] as never);

      expect(await upsertAddressBook(book)).toBe("existing-book");
    });

    it("stores the read-only flag as an integer", async () => {
      mockDb.select.mockResolvedValueOnce([{ id: "book-1" }] as never);

      await upsertAddressBook({ ...book, isReadOnly: true });

      expect(mockDb.execute.mock.calls[0]![1]).toContain(1);
    });
  });

  describe("getVisibleAddressBooks", () => {
    it("asks only for the books the user left switched on", async () => {
      await getVisibleAddressBooks("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("is_visible = 1"),
        ["acc-1"],
      );
    });
  });

  describe("getAddressBooksForAccount", () => {
    it("scopes the query to the account", async () => {
      await getAddressBooksForAccount("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("WHERE account_id = $1"),
        ["acc-1"],
      );
    });
  });

  describe("setAddressBookVisibility", () => {
    it("writes the flag as an integer", async () => {
      await setAddressBookVisibility("book-1", false);

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE address_books SET is_visible"),
        [0, "book-1"],
      );
    });
  });

  describe("updateAddressBookSyncState", () => {
    it("records ctag and sync token together", async () => {
      await updateAddressBookSyncState("book-1", "ctag-2", "token-2");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("ctag = $1, sync_token = $2"),
        ["ctag-2", "token-2", "book-1"],
      );
    });
  });
});
