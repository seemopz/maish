import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { EmailList } from "./EmailList";
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { useComposerStore } from "@/stores/composerStore";

let activeLabel = "inbox";

vi.mock("@/services/db/settings", () => ({ setSetting: vi.fn(() => Promise.resolve()) }));
vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => activeLabel,
  useSelectedThreadId: () => null,
  useActiveCategory: () => "All",
}));
vi.mock("@/router/navigate", () => ({ navigateToThread: vi.fn(), navigateToLabel: vi.fn() }));
vi.mock("@/services/db/threads", () => ({
  getThreadsForAccount: vi.fn(),
  getThreadsForCategory: vi.fn(() => Promise.resolve([])),
  getThreadLabelIds: vi.fn(() => Promise.resolve([])),
  deleteThread: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/db/threadCategories", () => ({
  getCategoriesForThreads: vi.fn(() => Promise.resolve(new Map())),
  getCategoryUnreadCounts: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock("@/services/db/followUpReminders", () => ({
  getActiveFollowUpThreadIds: vi.fn(() => Promise.resolve(new Set())),
}));
vi.mock("@/services/db/bundleRules", () => ({
  getBundleRules: vi.fn(() => Promise.resolve([])),
  getHeldThreadIds: vi.fn(() => Promise.resolve(new Set())),
  getBundleSummaries: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(() => Promise.reject(new Error("No Gmail client for this account"))),
}));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@/services/emailActions", () => ({
  archiveThread: vi.fn(() => Promise.resolve({ success: true })),
  trashThread: vi.fn(() => Promise.resolve({ success: true })),
  spamThread: vi.fn(() => Promise.resolve({ success: true })),
  permanentDeleteThread: vi.fn(() => Promise.resolve({ success: true })),
}));
vi.mock("@/services/undoableActions", () => ({
  undoBatch: vi.fn((fn: () => Promise<void>) => fn()),
}));
vi.mock("../email/ThreadCard", () => ({
  ThreadCard: ({ thread, onClick }: { thread: { id: string }; onClick: (t: unknown) => void }) => (
    <button data-testid={`thread-${thread.id}`} onClick={() => onClick(thread)} />
  ),
}));
vi.mock("../email/CategoryTabs", () => ({ CategoryTabs: () => null }));
vi.mock("../email/SyncNowButton", () => ({ SyncNowButton: () => null }));
vi.mock("../search/SearchBar", () => ({ SearchBar: () => null }));

import { getThreadsForAccount } from "@/services/db/threads";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getMessagesForThread } from "@/services/db/messages";
import { archiveThread, trashThread, spamThread, permanentDeleteThread } from "@/services/emailActions";
import { undoBatch } from "@/services/undoableActions";

const dbRow = (id: string) => ({
  id,
  account_id: "acct-1",
  subject: id,
  snippet: "",
  last_message_at: 0,
  message_count: 1,
  is_read: 1,
  is_starred: 0,
  is_pinned: 0,
  is_muted: 0,
  has_attachments: 0,
  from_name: null,
  from_address: null,
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => dbRow(`t${i}`));

async function renderLoaded() {
  render(<EmailList />);
  await waitFor(() => expect(screen.getByTestId("thread-t0")).toBeTruthy());
}

describe("EmailList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeLabel = "inbox";
    vi.mocked(getThreadsForAccount).mockResolvedValue(rows(3) as never);
    useAccountStore.setState({
      accounts: [{ id: "acct-1", email: "a@example.com", displayName: null, avatarUrl: null, isActive: true, provider: "imap" }],
      activeAccountId: "acct-1",
    });
    useThreadStore.setState({ threads: [], threadMap: new Map(), selectedThreadIds: new Set(), searchQuery: "", searchThreadIds: null });
  });

  describe("bulk actions go through emailActions, not the Gmail client", () => {
    const select = () => act(() => useThreadStore.setState({ selectedThreadIds: new Set(["t0", "t1"]) }));

    it("archives every selected thread as one undo step", async () => {
      await renderLoaded();
      select();
      fireEvent.click(screen.getByTitle("Archive selected"));
      await waitFor(() => expect(archiveThread).toHaveBeenCalledTimes(2));
      expect(archiveThread).toHaveBeenCalledWith("acct-1", "t0", []);
      expect(undoBatch).toHaveBeenCalledTimes(1);
      expect(getGmailClient).not.toHaveBeenCalled();
    });

    it("moves to trash outside the trash view", async () => {
      await renderLoaded();
      select();
      fireEvent.click(screen.getByTitle("Delete selected"));
      await waitFor(() => expect(trashThread).toHaveBeenCalledTimes(2));
      expect(permanentDeleteThread).not.toHaveBeenCalled();
    });

    it("deletes permanently inside the trash view", async () => {
      activeLabel = "trash";
      await renderLoaded();
      select();
      fireEvent.click(screen.getByTitle("Delete selected"));
      await waitFor(() => expect(permanentDeleteThread).toHaveBeenCalledTimes(2));
      expect(trashThread).not.toHaveBeenCalled();
    });

    it("reports spam outside the spam view", async () => {
      await renderLoaded();
      select();
      fireEvent.click(screen.getByTitle("Report spam"));
      await waitFor(() => expect(spamThread).toHaveBeenCalledWith("acct-1", "t1", [], true));
    });

    it("marks as not spam inside the spam view", async () => {
      activeLabel = "spam";
      await renderLoaded();
      select();
      fireEvent.click(screen.getByTitle("Not spam"));
      await waitFor(() => expect(spamThread).toHaveBeenCalledWith("acct-1", "t1", [], false));
    });
  });

  it("reloads on sync-done without clearing the search or cutting the list to one page", async () => {
    await renderLoaded();
    act(() => {
      const threads = rows(120).map((r) => ({ id: r.id, accountId: "acct-1", labelIds: [] }) as never);
      useThreadStore.setState({ threads, threadMap: new Map() });
      useThreadStore.getState().setSearch("invoice", new Set(["t5"]));
    });
    vi.mocked(getThreadsForAccount).mockClear();
    vi.mocked(getThreadsForAccount).mockResolvedValue(rows(120) as never);
    const loading = vi.fn();
    const unsub = useThreadStore.subscribe((s) => { if (s.isLoading) loading(); });

    window.dispatchEvent(new Event("maish-sync-done"));

    await waitFor(() => expect(getThreadsForAccount).toHaveBeenCalledWith("acct-1", "INBOX", 120, 0), { timeout: 2000 });
    await waitFor(() => expect(useThreadStore.getState().threads).toHaveLength(120));
    unsub();
    expect(useThreadStore.getState().searchQuery).toBe("invoice");
    expect(useThreadStore.getState().searchThreadIds).toEqual(new Set(["t5"]));
    expect(loading).not.toHaveBeenCalled();
  });

  it("opens an IMAP draft with its own message id, so saving replaces it instead of adding a copy", async () => {
    activeLabel = "drafts";
    const openComposer = vi.fn();
    useComposerStore.setState({ openComposer });
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "imap-acct-1-Drafts-7", to_addresses: "b@example.com", cc_addresses: null, bcc_addresses: null, subject: "Hi", body_html: "<p>x</p>", body_text: null },
    ] as never);
    await renderLoaded();

    fireEvent.click(screen.getByTestId("thread-t0"));

    await waitFor(() => expect(openComposer).toHaveBeenCalled());
    expect(openComposer).toHaveBeenCalledWith(expect.objectContaining({ draftId: "imap-acct-1-Drafts-7" }));
  });
});
