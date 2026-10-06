import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { discoverCardDavSettings, testCardDavConnection } from "./autoDiscovery";
import { findAccountByEmail } from "@/services/db/accounts";
import { createMockImapAccount } from "@/test/mocks";

vi.mock("tsdav", () => ({
  DAVClient: vi.fn(),
}));

// Discovery goes through the Rust HTTP client, not the webview's fetch.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("@/services/db/accounts", () => ({
  findAccountByEmail: vi.fn().mockResolvedValue(null),
}));

const mockDavFetch = vi.mocked(tauriFetch);
const mockFindAccountByEmail = vi.mocked(findAccountByEmail);

const redirectTo = (location: string) =>
  ({ status: 301, ok: false, headers: new Headers({ Location: location }) }) as Response;

const failure = () => ({ status: 404, ok: false, headers: new Headers() }) as Response;

describe("discoverCardDavSettings", () => {
  beforeEach(() => {
    mockDavFetch.mockReset();
    mockFindAccountByEmail.mockReset();
    mockFindAccountByEmail.mockResolvedValue(null);
  });

  it("returns the iCloud preset and says an app password is needed", async () => {
    expect(await discoverCardDavSettings("user@icloud.com")).toEqual({
      providerName: "iCloud",
      carddavUrl: "https://contacts.icloud.com",
      authMethod: "basic",
      needsAppPassword: true,
    });
  });

  it("marks Google as OAuth rather than offering a password field", async () => {
    const result = await discoverCardDavSettings("user@gmail.com");
    expect(result.providerName).toBe("Google");
    expect(result.authMethod).toBe("oauth2");
  });

  it("matches a preset regardless of the address's case", async () => {
    expect((await discoverCardDavSettings("User@FastMail.COM")).providerName).toBe("Fastmail");
  });

  it("follows the well-known redirect to the endpoint", async () => {
    mockDavFetch.mockResolvedValueOnce(redirectTo("https://dav.example.org/carddav/"));

    const result = await discoverCardDavSettings("user@example.org");

    expect(mockDavFetch).toHaveBeenCalledWith(
      "https://example.org/.well-known/carddav",
      expect.objectContaining({ maxRedirections: 0 }),
    );
    expect(result.carddavUrl).toBe("https://dav.example.org/carddav/");
  });

  it("resolves a relative Location against the host it asked", async () => {
    mockDavFetch.mockResolvedValueOnce(redirectTo("/dav/addressbooks/"));

    expect((await discoverCardDavSettings("user@example.org")).carddavUrl).toBe(
      "https://example.org/dav/addressbooks/",
    );
  });

  it("accepts a server that answers at the well-known URL directly", async () => {
    mockDavFetch.mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers() } as Response);

    expect((await discoverCardDavSettings("user@example.org")).carddavUrl).toBe(
      "https://example.org/.well-known/carddav",
    );
  });

  it("falls back to the mail server's host when the mail domain serves nothing", async () => {
    mockFindAccountByEmail.mockResolvedValue(
      createMockImapAccount({ email: "user@example.org", imap_host: "mail.provider.net" }),
    );
    mockDavFetch
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(redirectTo("https://mail.provider.net/dav/"));

    const result = await discoverCardDavSettings("user@example.org");

    expect(mockDavFetch).toHaveBeenNthCalledWith(
      2,
      "https://mail.provider.net/.well-known/carddav",
      expect.anything(),
    );
    expect(result.carddavUrl).toBe("https://mail.provider.net/dav/");
  });

  it("also tries the host the calendar already talks to", async () => {
    mockFindAccountByEmail.mockResolvedValue(
      createMockImapAccount({
        email: "user@example.org",
        imap_host: null,
        caldav_url: "https://dav.provider.net/caldav/",
      }),
    );
    mockDavFetch
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(redirectTo("https://dav.provider.net/carddav/"));

    expect((await discoverCardDavSettings("user@example.org")).carddavUrl).toBe(
      "https://dav.provider.net/carddav/",
    );
  });

  it("recognises a Nextcloud instance by its DAV path", async () => {
    mockDavFetch
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce({ status: 401, ok: false, headers: new Headers() } as Response);

    expect(await discoverCardDavSettings("user@cloud.example")).toEqual({
      providerName: "Nextcloud",
      carddavUrl: "https://cloud.example/remote.php/dav/",
      authMethod: "basic",
      needsAppPassword: false,
    });
  });

  it("returns nothing rather than a guess when every probe fails", async () => {
    mockDavFetch.mockResolvedValue(failure());

    expect(await discoverCardDavSettings("user@example.org")).toEqual({
      providerName: null,
      carddavUrl: null,
      authMethod: "basic",
      needsAppPassword: false,
    });
  });

  it("survives a probe that throws", async () => {
    mockDavFetch.mockRejectedValue(new Error("network unreachable"));

    expect((await discoverCardDavSettings("user@example.org")).carddavUrl).toBeNull();
  });

  it("returns nothing for an address without a domain", async () => {
    expect((await discoverCardDavSettings("nonsense")).carddavUrl).toBeNull();
    expect(mockDavFetch).not.toHaveBeenCalled();
  });
});

describe("testCardDavConnection", () => {
  it("reports the address books the credentials reach", async () => {
    const { DAVClient } = await import("tsdav");
    vi.mocked(DAVClient).mockImplementation(function (this: Record<string, unknown>) {
      this.login = vi.fn().mockResolvedValue(undefined);
      this.fetchAddressBooks = vi.fn().mockResolvedValue([{ url: "a" }]);
    } as never);

    expect(await testCardDavConnection("https://dav.example.org", "u", "p")).toEqual({
      success: true,
      message: "Connected — found 1 address book",
      addressBookCount: 1,
    });
  });

  it("reports the server's own message on failure", async () => {
    const { DAVClient } = await import("tsdav");
    vi.mocked(DAVClient).mockImplementation(function (this: Record<string, unknown>) {
      this.login = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    } as never);

    expect(await testCardDavConnection("https://dav.example.org", "u", "p")).toEqual({
      success: false,
      message: "401 Unauthorized",
    });
  });
});
