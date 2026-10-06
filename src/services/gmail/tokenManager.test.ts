import { reauthorizeAccount } from "./tokenManager";
import { createMockGmailAccount } from "@/test/mocks";

const mockFindAccount = vi.fn();
const mockGetAccount = vi.fn();
const mockUpdateAllTokens = vi.fn();

vi.mock("../db/accounts", () => ({
  getAllAccounts: vi.fn(),
  findAccount: (...args: unknown[]) => mockFindAccount(...args),
  getAccount: (...args: unknown[]) => mockGetAccount(...args),
  updateAccountAllTokens: (...args: unknown[]) => mockUpdateAllTokens(...args),
}));

vi.mock("../db/settings", () => ({
  getSetting: vi.fn(async () => "client-id"),
  getSecureSetting: vi.fn(async () => null),
}));

vi.mock("./auth", () => ({
  startOAuthFlow: vi.fn(async () => ({
    tokens: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
    userInfo: { email: "user@gmail.com" },
  })),
}));

describe("reauthorizeAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("works for an account whose stored token cannot be decrypted", async () => {
    // Re-authorizing is the way out of an unreadable token, so the existence
    // check must not insist on readable credentials.
    mockFindAccount.mockResolvedValue({
      ...createMockGmailAccount(),
      access_token: null,
      refresh_token: null,
      credentialError: "Could not decrypt the access token of user@gmail.com: key missing",
    });
    mockGetAccount.mockRejectedValue(new Error("Could not decrypt the access token"));

    await reauthorizeAccount("acc-gmail", "user@gmail.com");

    expect(mockUpdateAllTokens).toHaveBeenCalledWith(
      "acc-gmail",
      "new-access",
      "new-refresh",
      expect.any(Number),
    );
  });

  it("rejects an unknown account", async () => {
    mockFindAccount.mockResolvedValue(null);

    await expect(reauthorizeAccount("nope", "user@gmail.com")).rejects.toThrow(/not found/);
  });
});
