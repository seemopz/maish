import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetPending = vi.fn(() => Promise.resolve([] as unknown[]));
const mockUpdateStatus = vi.fn(() => Promise.resolve());
const mockGetAccount = vi.fn();
const mockClaim = vi.fn((_id: string) => Promise.resolve(true));
const mockSendMessage = vi.fn(() => Promise.resolve({ id: "sent-1" }));
const mockGetEmailProvider = vi.fn(() => Promise.resolve({ sendMessage: mockSendMessage }));
const mockGetGmailClient = vi.fn(() => {
  throw new Error("No Gmail client for this account");
});

vi.mock("../db/scheduledEmails", () => ({
  getPendingScheduledEmails: (...a: unknown[]) => mockGetPending(...a),
  updateScheduledEmailStatus: (...a: unknown[]) => mockUpdateStatus(...(a as [])),
  claimScheduledEmail: (...a: unknown[]) => mockClaim(...(a as [])),
  requeueInterruptedScheduledEmails: vi.fn(async () => {}),
}));
vi.mock("../db/accounts", () => ({
  getAccount: (...a: unknown[]) => mockGetAccount(...(a as [])),
}));
vi.mock("../email/providerFactory", () => ({
  getEmailProvider: (...a: unknown[]) => mockGetEmailProvider(...(a as [])),
}));
vi.mock("../gmail/tokenManager", () => ({
  getGmailClient: (...a: unknown[]) => mockGetGmailClient(...(a as [])),
}));
vi.mock("../backgroundCheckers", () => ({
  createBackgroundChecker: (_name: string, fn: () => Promise<void>) => ({
    start: () => {},
    stop: () => {},
    run: fn,
  }),
}));

import { __checkScheduledEmailsForTest } from "./scheduledSendManager";

/**
 * A scheduled send used to go through getGmailClient regardless of the
 * account's provider. On an IMAP account there is no Gmail client, so the
 * call threw; the catch could not read a 5xx or a network error out of the
 * message, marked the row "failed" and moved on. The mail the user had
 * scheduled was never sent and nothing said so.
 */
describe("checkScheduledEmails", () => {
  const imapEmail = {
    id: "sched-1",
    account_id: "acct-imap",
    to_addresses: "bob@example.com",
    cc_addresses: null,
    bcc_addresses: null,
    subject: "Later",
    body_html: "<p>hello</p>",
    thread_id: null,
    attachment_paths: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue({
      id: "acct-imap",
      email: "simon@hochreiner.xyz",
      provider: "imap",
    });
    mockGetEmailProvider.mockResolvedValue({ sendMessage: mockSendMessage });
  });

  it("sends through the account's own provider", async () => {
    mockGetPending.mockResolvedValue([imapEmail]);

    await __checkScheduledEmailsForTest();

    expect(mockGetEmailProvider).toHaveBeenCalledWith("acct-imap");
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("never reaches for a Gmail client", async () => {
    mockGetPending.mockResolvedValue([imapEmail]);

    await __checkScheduledEmailsForTest();

    expect(mockGetGmailClient).not.toHaveBeenCalled();
  });

  it("does not send a row another run has already claimed", async () => {
    mockGetPending.mockResolvedValue([imapEmail]);
    mockClaim.mockResolvedValueOnce(false);

    await __checkScheduledEmailsForTest();

    expect(mockClaim).toHaveBeenCalledWith("sched-1");
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("marks the mail sent rather than failed", async () => {
    mockGetPending.mockResolvedValue([imapEmail]);

    await __checkScheduledEmailsForTest();

    expect(mockClaim).toHaveBeenCalledWith("sched-1");
    expect(mockUpdateStatus).toHaveBeenCalledWith("sched-1", "sent");
    expect(mockUpdateStatus).not.toHaveBeenCalledWith("sched-1", "failed");
  });
});
