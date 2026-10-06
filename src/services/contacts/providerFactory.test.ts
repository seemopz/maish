import {
  clearAllContactsProviders,
  getContactsProvider,
  hasContactsSupport,
  removeContactsProvider,
} from "./providerFactory";
import { CardDAVProvider } from "./carddavProvider";
import { findAccount, getAccount } from "@/services/db/accounts";
import { createMockGmailAccount, createMockImapAccount } from "@/test/mocks";

vi.mock("tsdav", () => ({ DAVClient: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/services/db/accounts", () => ({ getAccount: vi.fn(), findAccount: vi.fn() }));

const mockGetAccount = vi.mocked(getAccount);
const mockFindAccount = vi.mocked(findAccount);

const withCardDav = () =>
  createMockImapAccount({
    id: "acc-1",
    contacts_provider: "carddav",
    carddav_url: "https://dav.example.org",
  });

describe("getContactsProvider", () => {
  beforeEach(() => {
    clearAllContactsProviders();
    mockGetAccount.mockReset();
  });

  it("returns a CardDAV provider for a mail account with CardDAV configured", async () => {
    mockGetAccount.mockResolvedValue(withCardDav());

    expect(await getContactsProvider("acc-1")).toBeInstanceOf(CardDAVProvider);
  });

  it("returns a provider for a standalone CardDAV account", async () => {
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-2", provider: "carddav" }));

    expect(await getContactsProvider("acc-2")).toBeInstanceOf(CardDAVProvider);
  });

  it("refuses an account whose CardDAV settings are only half there", async () => {
    mockGetAccount.mockResolvedValue(
      createMockImapAccount({ id: "acc-3", contacts_provider: "carddav", carddav_url: null }),
    );

    await expect(getContactsProvider("acc-3")).rejects.toThrow(/No contacts provider/);
  });

  it("refuses a Gmail account, whose contacts are not served over DAV", async () => {
    mockGetAccount.mockResolvedValue(createMockGmailAccount({ id: "acc-4" }));

    await expect(getContactsProvider("acc-4")).rejects.toThrow(/No contacts provider/);
  });

  it("fails on an account that does not exist", async () => {
    mockGetAccount.mockResolvedValue(null);

    await expect(getContactsProvider("nope")).rejects.toThrow(/not found/);
  });

  it("hands back the same provider rather than logging in again", async () => {
    mockGetAccount.mockResolvedValue(withCardDav());

    expect(await getContactsProvider("acc-1")).toBe(await getContactsProvider("acc-1"));
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("builds a fresh provider once the cached one is dropped", async () => {
    mockGetAccount.mockResolvedValue(withCardDav());

    const first = await getContactsProvider("acc-1");
    removeContactsProvider("acc-1");

    expect(await getContactsProvider("acc-1")).not.toBe(first);
  });
});

describe("hasContactsSupport", () => {
  beforeEach(() => mockFindAccount.mockReset());

  it("is true for a configured mail account", async () => {
    mockFindAccount.mockResolvedValue(withCardDav());
    expect(await hasContactsSupport("acc-1")).toBe(true);
  });

  it("is true for a standalone CardDAV account", async () => {
    mockFindAccount.mockResolvedValue(createMockImapAccount({ provider: "carddav" }));
    expect(await hasContactsSupport("acc-2")).toBe(true);
  });

  it("is false for a Gmail account", async () => {
    mockFindAccount.mockResolvedValue(createMockGmailAccount());
    expect(await hasContactsSupport("acc-3")).toBe(false);
  });

  it("is false for an account that does not exist", async () => {
    mockFindAccount.mockResolvedValue(null);
    expect(await hasContactsSupport("nope")).toBe(false);
  });

  it("does not need a readable credential", async () => {
    mockGetAccount.mockRejectedValue(new Error("credential cannot be decrypted"));
    mockFindAccount.mockResolvedValue(withCardDav());
    expect(await hasContactsSupport("acc-1")).toBe(true);
  });
});
