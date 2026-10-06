import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { discoverCalDavSettings, testCalDavConnection } from "./autoDiscovery";
import { davFetch } from "./davFetch";
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
  ({
    status: 301,
    ok: false,
    headers: new Headers({ Location: location }),
  }) as Response;

describe("discoverCalDavSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockDavFetch.mockReset();
    mockFindAccountByEmail.mockReset();
    mockFindAccountByEmail.mockResolvedValue(null);
  });

  it("returns Google preset for gmail.com", async () => {
    const result = await discoverCalDavSettings("user@gmail.com");
    expect(result).toEqual({
      providerName: "Google",
      caldavUrl: "https://apidata.googleusercontent.com/caldav/v2/",
      authMethod: "oauth2",
      needsAppPassword: false,
    });
  });

  it("returns iCloud preset for icloud.com with needsAppPassword", async () => {
    const result = await discoverCalDavSettings("user@icloud.com");
    expect(result).toEqual({
      providerName: "iCloud",
      caldavUrl: "https://caldav.icloud.com",
      authMethod: "basic",
      needsAppPassword: true,
    });
  });

  it("returns Fastmail preset for fastmail.com", async () => {
    const result = await discoverCalDavSettings("user@fastmail.com");
    expect(result).toEqual({
      providerName: "Fastmail",
      caldavUrl: "https://caldav.fastmail.com/",
      authMethod: "basic",
      needsAppPassword: false,
    });
  });

  it("returns Google preset with oauth2 authMethod", async () => {
    const result = await discoverCalDavSettings("user@googlemail.com");
    expect(result.authMethod).toBe("oauth2");
  });

  it("returns null caldavUrl for unknown domain with no .well-known", async () => {
    mockDavFetch.mockRejectedValue(new Error("Network error"));

    const result = await discoverCalDavSettings("user@unknown-domain.example");
    expect(result).toEqual({
      providerName: null,
      caldavUrl: null,
      authMethod: "basic",
      needsAppPassword: false,
    });
  });

  it("falls back to the account's mail server when the address domain has none", async () => {
    // Self-hosted setups routinely split the two: mail lives on
    // mail.example.net while example.com serves no .well-known at all.
    mockFindAccountByEmail.mockResolvedValue(
      createMockImapAccount({ imap_host: "mail.example.net" }),
    );
    mockDavFetch.mockImplementation(async (input) =>
      String(input).startsWith("https://mail.example.net/")
        ? redirectTo("https://mail.example.net/dav/cal")
        : Promise.reject(new Error("Not found")),
    );

    const result = await discoverCalDavSettings("user@example.com");

    expect(result.caldavUrl).toBe("https://mail.example.net/dav/cal");
  });

  it("prefers the address domain over the mail server", async () => {
    mockFindAccountByEmail.mockResolvedValue(
      createMockImapAccount({ imap_host: "mail.example.net" }),
    );
    mockDavFetch.mockResolvedValue(redirectTo("https://example.com/dav/cal"));

    const result = await discoverCalDavSettings("user@example.com");

    expect(result.caldavUrl).toBe("https://example.com/dav/cal");
  });

  it("does not probe the mail server when it matches the address domain", async () => {
    mockFindAccountByEmail.mockResolvedValue(
      createMockImapAccount({ imap_host: "example.com" }),
    );
    mockDavFetch.mockRejectedValue(new Error("Network error"));

    await discoverCalDavSettings("user@example.com");

    const probed = mockDavFetch.mock.calls.map(([input]) => String(input));
    expect(probed).toEqual([
      "https://example.com/.well-known/caldav",
      "https://example.com/remote.php/dav/",
    ]);
  });

  it("returns redirect Location for unknown domain with .well-known 307", async () => {
    mockDavFetch.mockResolvedValue({
      status: 307,
      ok: false,
      headers: new Headers({
        Location: "https://unknown-domain.example/dav/cal",
      }),
    } as Response);

    const result = await discoverCalDavSettings("user@unknown-domain.example");
    expect(result.caldavUrl).toBe("https://unknown-domain.example/dav/cal");
  });

  it("returns redirect Location for unknown domain with .well-known 301", async () => {
    mockDavFetch.mockResolvedValue({
      status: 301,
      ok: false,
      headers: new Headers({
        Location: "https://caldav.unknown-domain.example/dav/",
      }),
    } as Response);

    const result = await discoverCalDavSettings("user@unknown-domain.example");
    expect(result).toEqual({
      providerName: null,
      caldavUrl: "https://caldav.unknown-domain.example/dav/",
      authMethod: "basic",
      needsAppPassword: false,
    });
  });
});

describe("testCalDavConnection", () => {
  it("returns success with calendar count on successful connection", async () => {
    const { DAVClient } = await import("tsdav");
    const mockLogin = vi.fn().mockResolvedValue(undefined);
    const mockFetchCalendars = vi
      .fn()
      .mockResolvedValue([{ displayName: "Personal" }, { displayName: "Work" }]);

    vi.mocked(DAVClient).mockImplementation(function () {
      return {
        login: mockLogin,
        fetchCalendars: mockFetchCalendars,
      } as unknown as InstanceType<typeof DAVClient>;
    });

    const result = await testCalDavConnection(
      "https://caldav.example.com",
      "user",
      "pass",
    );
    expect(result).toEqual({
      success: true,
      message: "Connected — found 2 calendars",
      calendarCount: 2,
    });
  });

  it("routes DAV requests through the Rust HTTP client", async () => {
    const { DAVClient } = await import("tsdav");

    vi.mocked(DAVClient).mockImplementation(function () {
      return {
        login: vi.fn().mockResolvedValue(undefined),
        fetchCalendars: vi.fn().mockResolvedValue([]),
      } as unknown as InstanceType<typeof DAVClient>;
    });

    await testCalDavConnection("https://caldav.example.com", "user", "pass");

    // tsdav resolves globalThis.fetch at import time and only falls back to
    // cross-fetch, so the override has to be handed to the client explicitly —
    // otherwise the webview issues the request and CORS kills it.
    expect(vi.mocked(DAVClient).mock.calls[0]?.[0]).toMatchObject({
      fetch: davFetch,
    });
  });

  it("returns failure with error message on failed connection", async () => {
    const { DAVClient } = await import("tsdav");

    vi.mocked(DAVClient).mockImplementation(function () {
      return {
        login: vi.fn().mockRejectedValue(new Error("Invalid credentials")),
      } as unknown as InstanceType<typeof DAVClient>;
    });

    const result = await testCalDavConnection(
      "https://caldav.example.com",
      "user",
      "wrong-pass",
    );
    expect(result).toEqual({
      success: false,
      message: "Invalid credentials",
    });
  });
});
