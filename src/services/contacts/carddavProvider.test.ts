import { DAVClient } from "tsdav";
import { CardDAVProvider, withTrailingSlash } from "./carddavProvider";
import { davFetch } from "@/services/calendar/davFetch";
import { ContactWriteError } from "./errors";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

const CARD = [
  "BEGIN:VCARD", "VERSION:3.0", "UID:anna-1", "FN:Anna Mustermann",
  "N:Mustermann;Anna;;;", "EMAIL;TYPE=WORK:anna@example.org",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ", "END:VCARD",
].join("\r\n");

/** tsdav hands back the raw fetch response, whatever the status. */
const davResponse = (status: number, statusText = "") =>
  new Response(null, { status, statusText });

const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockFetchAddressBooks = vi.fn();
const mockFetchVCards = vi.fn();
const mockCreateVCard = vi.fn().mockResolvedValue(davResponse(201));
const mockUpdateVCard = vi.fn().mockResolvedValue(davResponse(204));
const mockDeleteVCard = vi.fn().mockResolvedValue(davResponse(204));
const mockPropfind = vi.fn().mockResolvedValue([]);

vi.mock("tsdav", () => {
  const MockDAVClient = vi.fn(function (this: Record<string, unknown>) {
    this.login = mockLogin;
    this.account = { homeUrl: "https://dav.example.org/books/" };
    this.fetchAddressBooks = mockFetchAddressBooks;
    this.fetchVCards = mockFetchVCards;
    this.createVCard = mockCreateVCard;
    this.updateVCard = mockUpdateVCard;
    this.deleteVCard = mockDeleteVCard;
    this.propfind = mockPropfind;
  });
  return { DAVClient: MockDAVClient };
});

vi.mock("@/services/db/accounts", () => ({
  getAccount: vi.fn().mockResolvedValue({
    id: "acc-1",
    email: "user@example.com",
    carddav_url: "https://dav.example.org",
    carddav_username: "user@example.com",
    carddav_password: "secret",
  }),
}));

describe("CardDAVProvider", () => {
  let provider: CardDAVProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPropfind.mockResolvedValue([]);
    provider = new CardDAVProvider("acc-1");
  });

  it("routes DAV requests through the Rust HTTP client", async () => {
    mockFetchAddressBooks.mockResolvedValue([]);

    await provider.listAddressBooks();

    expect(DAVClient).toHaveBeenCalledWith(expect.objectContaining({ fetch: davFetch }));
  });

  it("asks for the address book home rather than the calendar home", async () => {
    mockFetchAddressBooks.mockResolvedValue([]);

    await provider.listAddressBooks();

    expect(DAVClient).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAccountType: "carddav" }),
    );
  });

  it("logs in once and reuses the client", async () => {
    mockFetchAddressBooks.mockResolvedValue([]);

    await provider.listAddressBooks();
    await provider.listAddressBooks();

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("logs in again after a failed login instead of keeping the half-built client", async () => {
    mockLogin.mockRejectedValueOnce(new Error("offline"));
    mockFetchAddressBooks.mockResolvedValue([]);

    await expect(provider.listAddressBooks()).rejects.toThrow("offline");
    await provider.listAddressBooks();

    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  describe("listAddressBooks", () => {
    it("reads name, ctag and sync token", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        {
          url: "https://dav.example.org/books/default/",
          displayName: "Kontakte",
          ctag: "ctag-1",
          syncToken: "token-1",
        },
      ]);

      const books = await provider.listAddressBooks();

      expect(books).toEqual([
        {
          remoteId: "https://dav.example.org/books/default/",
          displayName: "Kontakte",
          description: null,
          isReadOnly: false,
          ctag: "ctag-1",
          syncToken: "token-1",
        },
      ]);
    });

    it("gives a book without a name a usable label", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/a/", displayName: {} },
      ]);

      expect((await provider.listAddressBooks())[0]!.displayName).toBe("Address Book 1");
    });

    it("normalises a collection URL that has no trailing slash", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/default", displayName: "K" },
      ]);

      expect((await provider.listAddressBooks())[0]!.remoteId).toBe(
        "https://dav.example.org/books/default/",
      );
    });

    it("marks a book read-only when the server grants no write privilege", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/shared/", displayName: "Geteilt" },
        { url: "https://dav.example.org/books/mine/", displayName: "Meine" },
      ]);
      mockPropfind.mockResolvedValue([
        {
          href: "/books/shared/",
          props: { currentUserPrivilegeSet: { privilege: [{ read: {} }] } },
        },
        {
          href: "/books/mine/",
          props: { currentUserPrivilegeSet: { privilege: [{ read: {} }, { write: {} }] } },
        },
      ]);

      const books = await provider.listAddressBooks();

      expect(books.find((b) => b.displayName === "Geteilt")!.isReadOnly).toBe(true);
      expect(books.find((b) => b.displayName === "Meine")!.isReadOnly).toBe(false);
    });

    it("treats a book as writable when the server reports no privileges at all", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/default/", displayName: "K" },
      ]);
      mockPropfind.mockResolvedValue([{ href: "/books/default/", props: {} }]);

      expect((await provider.listAddressBooks())[0]!.isReadOnly).toBe(false);
    });

    it("treats a book as writable when the privilege request fails", async () => {
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/default/", displayName: "K" },
      ]);
      mockPropfind.mockRejectedValue(new Error("not supported"));

      expect((await provider.listAddressBooks())[0]!.isReadOnly).toBe(false);
    });
  });

  describe("fetchContacts", () => {
    it("parses every card and keeps its etag", async () => {
      mockFetchVCards.mockResolvedValue([
        { url: "https://dav.example.org/books/default/anna.vcf", data: CARD, etag: "etag-1" },
      ]);

      const contacts = await provider.fetchContacts("https://dav.example.org/books/default/");

      expect(contacts).toHaveLength(1);
      expect(contacts[0]!.displayName).toBe("Anna Mustermann");
      expect(contacts[0]!.uid).toBe("anna-1");
      expect(contacts[0]!.etag).toBe("etag-1");
      expect(contacts[0]!.remoteContactId).toBe(
        "https://dav.example.org/books/default/anna.vcf",
      );
    });

    it("skips an object the server returned without data", async () => {
      mockFetchVCards.mockResolvedValue([
        { url: "https://dav.example.org/books/default/leer.vcf", etag: "e" },
        { url: "https://dav.example.org/books/default/anna.vcf", data: CARD, etag: "e2" },
      ]);

      expect(await provider.fetchContacts("https://dav.example.org/books/default/")).toHaveLength(1);
    });
  });

  describe("createContact", () => {
    it("writes a card and reports where it was stored", async () => {
      const created = await provider.createContact("https://dav.example.org/books/default/", {
        displayName: "Bert Bauer",
        emails: [{ address: "bert@example.org", type: "WORK", isPrimary: true }],
      });

      const call = mockCreateVCard.mock.calls[0]![0];
      expect(call.vCardString).toContain("FN:Bert Bauer");
      expect(call.filename).toMatch(/\.vcf$/);
      expect(created.remoteContactId).toBe(
        `https://dav.example.org/books/default/${call.filename}`,
      );
      expect(created.displayName).toBe("Bert Bauer");
    });

    it("addresses the collection itself when its URL lacks a trailing slash", async () => {
      await provider.createContact("https://dav.example.org/books/default", {
        displayName: "Bert",
      });

      expect(mockCreateVCard.mock.calls[0]![0].addressBook.url).toBe(
        "https://dav.example.org/books/default/",
      );
    });

    it("turns a refused write into an error", async () => {
      mockCreateVCard.mockResolvedValueOnce(davResponse(403, "Forbidden"));

      await expect(
        provider.createContact("https://dav.example.org/books/default/", { displayName: "B" }),
      ).rejects.toThrow(ContactWriteError);
    });
  });

  describe("updateContact", () => {
    beforeEach(() => {
      mockFetchVCards.mockResolvedValue([
        { url: "https://dav.example.org/books/default/anna.vcf", data: CARD, etag: "etag-1" },
      ]);
    });

    it("patches the stored card rather than rebuilding it", async () => {
      await provider.updateContact(
        "https://dav.example.org/books/default/",
        "https://dav.example.org/books/default/anna.vcf",
        { displayName: "Anna M. Mustermann" },
      );

      const written = mockUpdateVCard.mock.calls[0]![0].vCard.data as string;
      expect(written).toContain("FN:Anna M. Mustermann");
      // Everything the edit did not mention is still there.
      expect(written).toContain("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ");
      expect(written).toContain("UID:anna-1");
    });

    it("passes the etag on the card so tsdav builds the If-Match itself", async () => {
      await provider.updateContact(
        "https://dav.example.org/books/default/",
        "https://dav.example.org/books/default/anna.vcf",
        { displayName: "Anna M." },
        "etag-from-caller",
      );

      const call = mockUpdateVCard.mock.calls[0]![0];
      expect(call.vCard.etag).toBe("etag-from-caller");
      // A headers argument would replace the authorization header the client
      // set at login, and every write would come back 401.
      expect(call.headers).toBeUndefined();
    });

    it("falls back to the etag the server just reported", async () => {
      await provider.updateContact(
        "https://dav.example.org/books/default/",
        "https://dav.example.org/books/default/anna.vcf",
        { displayName: "Anna M." },
      );

      expect(mockUpdateVCard.mock.calls[0]![0].vCard.etag).toBe("etag-1");
    });

    it("reports a card that changed on the server as a conflict", async () => {
      mockUpdateVCard.mockResolvedValueOnce(davResponse(412, "Precondition Failed"));

      await expect(
        provider.updateContact(
          "https://dav.example.org/books/default/",
          "https://dav.example.org/books/default/anna.vcf",
          { displayName: "Anna M." },
        ),
      ).rejects.toMatchObject({ status: 412, isConflict: true });
    });

    it("reports an unauthorised write instead of passing it off as saved", async () => {
      mockUpdateVCard.mockResolvedValueOnce(davResponse(401, "Unauthorized"));

      await expect(
        provider.updateContact(
          "https://dav.example.org/books/default/",
          "https://dav.example.org/books/default/anna.vcf",
          { displayName: "Anna M." },
        ),
      ).rejects.toThrow(/401/);
    });

    it("fails when the card is gone from the server", async () => {
      mockFetchVCards.mockResolvedValue([]);

      await expect(
        provider.updateContact(
          "https://dav.example.org/books/default/",
          "https://dav.example.org/books/default/anna.vcf",
          { displayName: "Anna M." },
        ),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("deleteContact", () => {
    it("deletes the object with its etag", async () => {
      await provider.deleteContact("https://dav.example.org/books/default/anna.vcf", "etag-1");

      expect(mockDeleteVCard).toHaveBeenCalledWith({
        vCard: { url: "https://dav.example.org/books/default/anna.vcf", etag: "etag-1" },
      });
    });

    it("turns a refused delete into an error", async () => {
      mockDeleteVCard.mockResolvedValueOnce(davResponse(403, "Forbidden"));

      await expect(
        provider.deleteContact("https://dav.example.org/books/default/anna.vcf"),
      ).rejects.toMatchObject({ status: 403, isForbidden: true });
    });
  });

  describe("syncContacts", () => {
    it("returns the cards along with the book's ctag", async () => {
      mockFetchVCards.mockResolvedValue([
        { url: "https://dav.example.org/books/default/anna.vcf", data: CARD, etag: "etag-1" },
      ]);
      mockFetchAddressBooks.mockResolvedValue([
        { url: "https://dav.example.org/books/default/", displayName: "K", ctag: "ctag-9" },
      ]);

      const result = await provider.syncContacts("https://dav.example.org/books/default/");

      expect(result.cards).toHaveLength(1);
      expect(result.newCtag).toBe("ctag-9");
    });
  });

  describe("testConnection", () => {
    it("reports how many books the credentials reach", async () => {
      mockFetchAddressBooks.mockResolvedValue([{ url: "a" }, { url: "b" }]);

      expect(await provider.testConnection()).toEqual({
        success: true,
        message: "Connected — found 2 address books",
      });
    });

    it("reports a failure and drops the client so a retry re-logs in", async () => {
      mockFetchAddressBooks.mockRejectedValueOnce(new Error("401 Unauthorized"));

      const result = await provider.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain("401");

      mockFetchAddressBooks.mockResolvedValue([]);
      await provider.listAddressBooks();
      expect(mockLogin).toHaveBeenCalledTimes(2);
    });
  });
});

describe("withTrailingSlash", () => {
  it("adds a slash only where one is missing", () => {
    expect(withTrailingSlash("https://x/books")).toBe("https://x/books/");
    expect(withTrailingSlash("https://x/books/")).toBe("https://x/books/");
  });
});
