import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useComposerStore } from "@/stores/composerStore";
import { startAutoSave, stopAutoSave, flushAutoSave } from "./draftAutoSave";
import { createDraft, updateDraft } from "@/services/emailActions";
import { buildRawEmail } from "@/utils/emailBuilder";
import { logToFile } from "@/services/logFile";

// Mock emailActions instead of getGmailClient
vi.mock("@/services/emailActions", () => ({
  createDraft: vi.fn().mockResolvedValue({ success: true, data: { draftId: "draft-1" } }),
  updateDraft: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));

vi.mock("@/utils/emailBuilder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/emailBuilder")>();
  return { ...actual, buildRawEmail: vi.fn(actual.buildRawEmail) };
});

import { createMockAccountStoreState } from "@/test/mocks";

vi.mock("@/stores/accountStore", () => ({
  useAccountStore: {
    getState: () => createMockAccountStoreState({
      accounts: [{ id: "account-1", email: "test@example.com" }],
    }),
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("draftAutoSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useComposerStore.setState({
      isOpen: true,
      session: 1,
      mode: "new",
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: "Test",
      bodyHtml: "<p>Hello</p>",
      threadId: null,
      inReplyToMessageId: null,
      references: null,
      fromEmail: null,
      showCcBcc: false,
      draftId: null,
      undoSendTimer: null,
      undoSendVisible: false,
      attachments: [],
      lastSavedAt: null,
      isSaving: false,
      signatureHtml: "",
      signatureId: null,
    });
  });

  afterEach(() => {
    stopAutoSave();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops without error", () => {
    startAutoSave("account-1");
    stopAutoSave();
  });

  it("triggers save after debounce when body changes", async () => {
    startAutoSave("account-1");

    // Simulate a body change
    useComposerStore.getState().setBodyHtml("<p>Updated</p>");

    // Before debounce, draft should not be saved
    expect(useComposerStore.getState().draftId).toBeNull();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(3500);

    // Draft should now be saved
    expect(useComposerStore.getState().draftId).toBe("draft-1");
    expect(useComposerStore.getState().lastSavedAt).not.toBeNull();
  });

  it("does not save when composer is closed", async () => {
    startAutoSave("account-1");

    useComposerStore.setState({ isOpen: false });
    useComposerStore.getState().setSubject("Changed");

    await vi.advanceTimersByTimeAsync(3500);

    expect(useComposerStore.getState().draftId).toBeNull();
  });

  it("saves cc, bcc, the reply headers and the chosen From address", async () => {
    useComposerStore.setState({
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      inReplyToMessageId: "<m1@example.com>",
      references: "<r0@example.com> <m1@example.com>",
      fromEmail: "alias@example.com",
    });
    startAutoSave("account-1");
    useComposerStore.getState().setSubject("Changed");
    await vi.advanceTimersByTimeAsync(3500);

    expect(buildRawEmail).toHaveBeenCalledWith(expect.objectContaining({
      from: "alias@example.com",
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      inReplyTo: "<m1@example.com>",
      references: "<r0@example.com> <m1@example.com>",
    }));
  });

  it("does not hand a draft id to a compose session that started during the save", async () => {
    const pending = deferred<{ success: boolean; data: { draftId: string } }>();
    vi.mocked(createDraft).mockReturnValueOnce(pending.promise);
    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>first mail</p>");
    await vi.advanceTimersByTimeAsync(3500);

    useComposerStore.getState().openComposer({ to: ["other@example.com"] });
    pending.resolve({ success: true, data: { draftId: "draft-of-first-mail" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(useComposerStore.getState().draftId).toBeNull();
  });

  it("takes the new id an update returns", async () => {
    useComposerStore.setState({ draftId: "imap-account-1-Drafts-1" });
    vi.mocked(updateDraft).mockResolvedValueOnce({ success: true, data: { draftId: "imap-account-1-Drafts-2" } });
    startAutoSave("account-1");
    useComposerStore.getState().setSubject("Changed");
    await vi.advanceTimersByTimeAsync(3500);

    expect(useComposerStore.getState().draftId).toBe("imap-account-1-Drafts-2");
  });

  it("flushAutoSave writes pending edits without waiting for the debounce", async () => {
    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>typed just before closing</p>");

    await flushAutoSave();

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(useComposerStore.getState().draftId).toBe("draft-1");
  });

  it("does not create a second draft while the first save is still running", async () => {
    const pending = deferred<{ success: boolean; data: { draftId: string } }>();
    vi.mocked(createDraft).mockReturnValueOnce(pending.promise);
    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>one</p>");
    await vi.advanceTimersByTimeAsync(3500);
    useComposerStore.getState().setBodyHtml("<p>two</p>");
    await vi.advanceTimersByTimeAsync(3500);

    pending.resolve({ success: true, data: { draftId: "draft-1" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(updateDraft).toHaveBeenCalledWith("account-1", "draft-1", expect.any(String), undefined);
  });

  // A permanent error is returned, not thrown; the footer still said "Draft saved".
  it("does not report a draft as saved when the save failed", async () => {
    vi.mocked(createDraft).mockResolvedValueOnce({ success: false, error: "quota exceeded" });
    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>not saved</p>");

    await flushAutoSave();

    expect(useComposerStore.getState().lastSavedAt).toBeNull();
    expect(logToFile).toHaveBeenCalledWith("error", expect.stringContaining("quota exceeded"));
  });
});
