import { describe, it, expect, beforeEach, vi } from "vitest";

const mockComplete = vi.fn();

vi.mock("./providerManager", () => ({
  getActiveProvider: vi.fn(() => ({
    complete: mockComplete,
    testConnection: vi.fn(() => Promise.resolve(true)),
  })),
}));

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(() => Promise.resolve(null)),
  setAiCache: vi.fn(),
  deleteAiCache: vi.fn(),
}));

const mockGetSetting = vi.fn((_key: string): Promise<string | null> => Promise.resolve(null));
vi.mock("@/services/db/settings", () => ({
  getSetting: (key: string) => mockGetSetting(key),
}));

import { classifyThreadsBySmartLabels, summarizeThread, askInbox, extractTaskFromThread, generateSmartReplies } from "./aiService";
import { getAiCache, setAiCache, deleteAiCache } from "@/services/db/aiCache";
import type { DbMessage } from "@/services/db/messages";

describe("smart replies cache", () => {
  const messages = [
    { subject: "Druck", from_name: "Anna", from_address: "anna@example.de", date: 0, body_text: "Bitte ausdrucken" },
  ] as unknown as DbMessage[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockImplementation(async () => null);
    mockComplete.mockResolvedValue('["Mach ich!", "Gerne.", "Erledigt."]');
  });

  it("ignores replies cached before they followed the mail language", async () => {
    vi.mocked(getAiCache).mockImplementationOnce(async (_a, _t, type) =>
      type === "smart_replies" ? '["Sure, will do!", "Thanks!", "Got it."]' : null,
    );
    expect(await generateSmartReplies("t1", "a1", messages)).toEqual(["Mach ich!", "Gerne.", "Erledigt."]);
    expect(setAiCache).toHaveBeenCalledWith("a1", "t1", "smart_replies_v2", expect.any(String));
  });

  it("shows fewer replies instead of padding them with an English one", async () => {
    mockComplete.mockResolvedValue('["Mach ich!", "<b></b>"]');
    expect(await generateSmartReplies("t1", "a1", messages)).toEqual(["Mach ich!"]);
  });
});

describe("summary language", () => {
  const messages = [
    { subject: "Termin", from_name: "Anna", from_address: "anna@example.de", date: 0, body_text: "Hallo" },
  ] as unknown as DbMessage[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockComplete.mockResolvedValue("ok");
    mockGetSetting.mockImplementation(async () => null);
  });

  function systemPrompt(): string {
    return mockComplete.mock.calls[0][0].systemPrompt as string;
  }

  it("summarizes in German when the setting is unset", async () => {
    await summarizeThread("t1", "a1", messages);
    expect(systemPrompt()).toContain("in German, even if");
    expect(getAiCache).toHaveBeenCalledWith("a1", "t1", "summary_de");
    expect(setAiCache).toHaveBeenCalledWith("a1", "t1", "summary_de", "ok");
  });

  it("follows the mail language and caches per language", async () => {
    mockGetSetting.mockImplementation(async (key) => (key === "ai_summary_language" ? "email" : null));
    await summarizeThread("t1", "a1", messages);
    expect(systemPrompt()).toContain("in the same language as the emails");
    expect(setAiCache).toHaveBeenCalledWith("a1", "t1", "summary_email", "ok");
  });

  it("skips and clears the cache on refresh", async () => {
    expect(await summarizeThread("t1", "a1", messages, { refresh: true })).toBe("ok");
    expect(getAiCache).not.toHaveBeenCalled();
    expect(deleteAiCache).toHaveBeenCalledWith("a1", "t1", "summary_de");
  });

  it("caches nothing when the provider rejects an incomplete reply", async () => {
    mockComplete.mockRejectedValueOnce(new Error("Claude stopped early (max_tokens), the reply is incomplete"));
    await expect(summarizeThread("t1", "a1", messages)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(setAiCache).not.toHaveBeenCalled();
  });

  it("answers Ask Inbox in the summary language, or in the question's language", async () => {
    mockGetSetting.mockImplementation(async (key) => (key === "ai_summary_language" ? "en" : null));
    await askInbox("Wann ist der Termin?", "a1", "ctx");
    expect(systemPrompt()).toContain("in English, even if");

    mockComplete.mockClear();
    mockGetSetting.mockImplementation(async (key) => (key === "ai_summary_language" ? "email" : null));
    await askInbox("Wann ist der Termin?", "a1", "ctx");
    expect(systemPrompt()).toContain("same language as the user's question");
  });

  it("extracts tasks in the summary language", async () => {
    await extractTaskFromThread("t1", "a1", messages);
    expect(systemPrompt()).toContain("in German, even if");
  });
});

describe("classifyThreadsBySmartLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const threads = [
    { id: "t1", subject: "Software Engineer Position", snippet: "We're hiring...", fromAddress: "recruiter@company.com" },
    { id: "t2", subject: "Your order shipped", snippet: "Package tracking...", fromAddress: "orders@shop.com" },
    { id: "t3", subject: "Team standup notes", snippet: "Meeting recap...", fromAddress: "pm@work.com" },
  ];

  const labelRules = [
    { labelId: "label-jobs", description: "Job applications and career opportunities" },
    { labelId: "label-orders", description: "Shopping orders and delivery updates" },
  ];

  it("parses valid AI response into assignments map", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs\nt2:label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
    expect(result.has("t3")).toBe(false);
  });

  it("supports multi-label assignments", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs", "label-orders"]);
  });

  it("ignores invalid thread IDs", async () => {
    mockComplete.mockResolvedValueOnce("invalid-id:label-jobs\nt1:label-jobs");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(1);
    expect(result.has("invalid-id")).toBe(false);
    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("ignores invalid label IDs", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("skips threads where all labels are invalid", async () => {
    mockComplete.mockResolvedValueOnce("t1:fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles empty AI response", async () => {
    mockComplete.mockResolvedValueOnce("");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles blank lines and whitespace in response", async () => {
    mockComplete.mockResolvedValueOnce("\n  t1:label-jobs  \n\n  t2:label-orders\n");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(2);
    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
  });

  it("passes label definitions and thread data to AI", async () => {
    mockComplete.mockResolvedValueOnce("");

    await classifyThreadsBySmartLabels(threads, labelRules);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0] as { userContent: string };
    expect(callArgs.userContent).toContain("label-jobs");
    expect(callArgs.userContent).toContain("Job applications");
    expect(callArgs.userContent).toContain("t1");
    expect(callArgs.userContent).toContain("recruiter@company.com");
  });
});
