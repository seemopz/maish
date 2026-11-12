import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./providerManager", () => ({ isAiAvailable: vi.fn(async () => true) }));
vi.mock("./aiService", () => ({ categorizeThreads: vi.fn(async () => new Map([["t1", "updates"]])) }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/services/db/threadCategories", () => ({
  getRecentRuleCategorizedThreadIds: vi.fn(),
  setThreadCategoriesBatch: vi.fn(),
}));

import { categorizeNewThreads } from "./categorizationManager";
import { categorizeThreads } from "./aiService";
import { getRecentRuleCategorizedThreadIds } from "@/services/db/threadCategories";

const thread = (id: string, lastMessageAt: number) =>
  ({ id, subject: "s", snippet: "x", fromAddress: "a@example.org", lastMessageAt });

describe("categorizeNewThreads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a thread to the AI once, and again only after it received new mail", async () => {
    vi.mocked(getRecentRuleCategorizedThreadIds).mockResolvedValue([thread("t1", 100), thread("t2", 100)]);
    await categorizeNewThreads("acc-cat");
    await categorizeNewThreads("acc-cat");
    expect(categorizeThreads).toHaveBeenCalledTimes(1);

    vi.mocked(getRecentRuleCategorizedThreadIds).mockResolvedValue([thread("t1", 200), thread("t2", 100)]);
    await categorizeNewThreads("acc-cat");
    expect(categorizeThreads).toHaveBeenCalledTimes(2);
    expect(vi.mocked(categorizeThreads).mock.calls[1]![0].map((t) => t.id)).toEqual(["t1"]);
  });
});
