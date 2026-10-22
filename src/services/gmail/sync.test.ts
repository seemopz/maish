import { describe, it, expect, vi, beforeEach } from "vitest";
import { deltaSync } from "./sync";
import { GmailClient } from "./client";
import { updateAccountSyncState } from "../db/accounts";
import { deleteThread } from "../db/threads";

// Mock all DB modules
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  deleteThread: vi.fn(),
  getMutedThreadIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/threadCategories", () => ({
  getThreadCategoryWithManual: vi.fn().mockResolvedValue(null),
  setThreadCategory: vi.fn(),
  getThreadCategory: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/notificationVips", () => ({
  getVipSenders: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("@/services/categorization/ruleEngine", () => ({
  categorizeByRules: vi.fn().mockReturnValue("Primary"),
}));
vi.mock("../filters/filterEngine", () => ({
  applyFiltersToMessages: vi.fn(),
}));
vi.mock("@/services/ai/categorizationManager", () => ({
  categorizeNewThreads: vi.fn(),
}));
vi.mock("@/services/db/bundleRules", () => ({
  getBundleRule: vi.fn().mockResolvedValue(null),
  holdThread: vi.fn(),
  getNextDeliveryTime: vi.fn(),
}));
vi.mock("@/services/db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn().mockResolvedValue([]),
}));

const mockNotify = vi.fn();
const mockShouldNotify = vi.fn().mockReturnValue(true);
vi.mock("../notifications/notificationManager", () => ({
  queueNewEmailNotification: (...args: unknown[]) => mockNotify(...args),
  shouldNotifyForMessage: (...args: unknown[]) => mockShouldNotify(...args),
}));

// Mock parseGmailMessage
vi.mock("./messageParser", () => ({
  parseGmailMessage: (msg: { id: string; threadId: string; labelIds: string[] }) => ({
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    fromAddress: "sender@example.com",
    fromName: "Sender",
    toAddresses: "me@example.com",
    ccAddresses: "",
    bccAddresses: "",
    replyTo: "",
    subject: `Subject for ${msg.id}`,
    snippet: "snippet",
    date: "2024-01-01T00:00:00Z",
    isRead: !msg.labelIds?.includes("UNREAD"),
    isStarred: false,
    bodyHtml: "<p>test</p>",
    bodyText: "test",
    rawSize: 100,
    internalDate: "1704067200000",
    hasAttachments: false,
    attachments: [],
  }),
}));

function createMockClient(historyItems: unknown[]): GmailClient {
  return {
    getHistory: vi.fn().mockResolvedValue({
      history: historyItems,
      historyId: "200",
    }),
    getThread: vi.fn().mockImplementation((threadId: string) =>
      Promise.resolve({
        id: threadId,
        historyId: "200",
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            labelIds: ["INBOX", "UNREAD"],
            snippet: "test",
            historyId: "200",
            internalDate: "1704067200000",
            payload: { partId: "", mimeType: "text/plain", filename: "", headers: [], body: { size: 0 } },
            sizeEstimate: 100,
          },
        ],
      }),
    ),
  } as unknown as GmailClient;
}

describe("deltaSync notifications", () => {
  beforeEach(() => {
    mockNotify.mockClear();
    mockShouldNotify.mockClear();
    mockShouldNotify.mockReturnValue(true);
  });

  it("sends notification for new unread inbox message", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-1",
              threadId: "thread-1",
              labelIds: ["INBOX", "UNREAD"],
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).toHaveBeenCalledWith(
      "Sender",
      "Subject for msg-thread-1",
      "thread-1",
      "account-1",
      "sender@example.com",
    );
  });

  it("does not send notification for read messages", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-2",
              threadId: "thread-2",
              labelIds: ["INBOX"], // no UNREAD
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not send notification for sent messages", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-3",
              threadId: "thread-3",
              labelIds: ["SENT"],
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("deltaSync history position", () => {
  const history = [
    { id: "100", labelsRemoved: [{ message: { id: "m1", threadId: "t-ok" } }] },
    { id: "101", labelsRemoved: [{ message: { id: "m2", threadId: "t-bad" } }] },
  ];

  /** getThread fails for `t-bad` with the given error. */
  function clientFailingOn(error: Error): GmailClient {
    const client = createMockClient(history);
    const ok = client.getThread as ReturnType<typeof vi.fn>;
    const original = ok.getMockImplementation()!;
    ok.mockImplementation((threadId: string, format?: string) =>
      threadId === "t-bad" ? Promise.reject(error) : original(threadId, format),
    );
    return client;
  }

  beforeEach(() => {
    vi.mocked(updateAccountSyncState).mockClear();
    vi.mocked(deleteThread).mockClear();
  });

  it("does not move past a thread that could not be fetched", async () => {
    const client = clientFailingOn(new Error("network down"));

    await expect(deltaSync(client, "acc-fail", "99")).rejects.toThrow("could not be synced");

    expect(updateAccountSyncState).not.toHaveBeenCalled();
  });

  it("moves on after repeated failures of the same thread", async () => {
    const client = clientFailingOn(new Error("network down"));

    for (let i = 0; i < 5; i++) {
      await expect(deltaSync(client, "acc-streak", "99")).rejects.toThrow("could not be synced");
    }
    await deltaSync(client, "acc-streak", "99");

    expect(updateAccountSyncState).toHaveBeenCalledWith("acc-streak", "200");
  });

  it("is not mistaken for an expired history when the count reads 404", async () => {
    const items = Array.from({ length: 404 }, (_, i) => ({
      id: `${i}`,
      labelsRemoved: [{ message: { id: `m${i}`, threadId: `t-bad-${i}` } }],
    }));
    const client = createMockClient(items);
    (client.getThread as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));

    await expect(deltaSync(client, "acc-404", "99")).rejects.toThrow("404 thread(s) could not be synced");
  });

  it("does not notify again for threads a failed run already stored", async () => {
    mockNotify.mockClear();
    const newMail = (threadId: string) => ({
      id: threadId,
      messagesAdded: [{ message: { id: `msg-${threadId}`, threadId, labelIds: ["INBOX", "UNREAD"] } }],
    });
    const client = createMockClient([newMail("t-ok"), newMail("t-bad")]);
    const getThread = client.getThread as ReturnType<typeof vi.fn>;
    const original = getThread.getMockImplementation()!;
    let badFails = true;
    getThread.mockImplementation((threadId: string, format?: string) =>
      threadId === "t-bad" && badFails ? Promise.reject(new Error("network down")) : original(threadId, format),
    );

    await expect(deltaSync(client, "acc-retry", "99")).rejects.toThrow("could not be synced");
    badFails = false;
    await deltaSync(client, "acc-retry", "99");

    const notified = mockNotify.mock.calls.map((c) => c[2]);
    expect(notified.filter((t) => t === "t-ok")).toHaveLength(1);
    expect(notified.filter((t) => t === "t-bad")).toHaveLength(1);
    expect(updateAccountSyncState).toHaveBeenCalledWith("acc-retry", "200");
  });

  it("drops a thread the server no longer has and moves on", async () => {
    const client = clientFailingOn(new Error("Gmail API error: 404 {\"error\":{\"code\":404}}"));

    await deltaSync(client, "acc-gone", "99");

    expect(deleteThread).toHaveBeenCalledWith("acc-gone", "t-bad");
    expect(updateAccountSyncState).toHaveBeenCalledWith("acc-gone", "200");
  });
});
