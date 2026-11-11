import { render, screen, act } from "@testing-library/react";
import { useUIStore } from "./stores/uiStore";
import { useAccountStore } from "./stores/accountStore";
import { useComposerStore } from "./stores/composerStore";

const win = vi.hoisted(() => {
  const unlisten = vi.fn(() => Promise.resolve());
  return {
    close: vi.fn().mockResolvedValue(undefined),
    unlisten,
    onCloseRequested: vi.fn((_handler: (e: { preventDefault: () => void }) => void) => Promise.resolve(unlisten)),
  };
});

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("./components/composer/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./components/composer/UndoSendToast", () => ({ UndoSendToast: () => null }));
vi.mock("./services/db/migrations", () => ({ runMigrations: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./services/db/accounts", () => ({
  getAllAccounts: vi.fn().mockResolvedValue([
    { id: "acct-1", email: "a@example.com", display_name: null, avatar_url: null, is_active: 1, provider: "imap" },
    { id: "acct-2", email: "b@example.com", display_name: null, avatar_url: null, is_active: 1, provider: "imap" },
  ]),
}));
vi.mock("./services/db/settings", () => ({ getSetting: vi.fn().mockResolvedValue(null) }));
vi.mock("./services/gmail/tokenManager", () => ({ initializeClients: vi.fn().mockResolvedValue(undefined) }));

import ComposerWindow from "./ComposerWindow";

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("ComposerWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/?compose=true&mode=reply&to=bob%40example.com&accountId=acct-2");
    // "system" would need matchMedia, which jsdom lacks
    useUIStore.setState({ theme: "light" });
    useAccountStore.setState({ accounts: [], activeAccountId: null });
    useComposerStore.setState({ isOpen: false, pendingSend: null, undoSendTimer: null });
  });

  // setAccounts without an id made accounts[0] active, so a reply from account B went out via A.
  it("writes from the account the composer was popped out of", async () => {
    render(<ComposerWindow />);
    await screen.findByTestId("composer");
    expect(useAccountStore.getState().activeAccountId).toBe("acct-2");
  });

  it("closes the window once the composer is closed and nothing is left to send", async () => {
    render(<ComposerWindow />);
    await screen.findByTestId("composer");

    act(() => useComposerStore.getState().closeComposer());
    await flush();

    expect(win.close).toHaveBeenCalled();
  });

  // Closing the window during the undo window killed the timer, and the mail with it.
  it("refuses to close while a send is waiting and closes once it is done", async () => {
    render(<ComposerWindow />);
    await screen.findByTestId("composer");

    act(() => {
      useComposerStore.getState().setPendingSend({
        mode: "new", to: ["bob@example.com"], cc: [], bcc: [], subject: "", bodyHtml: "",
        threadId: null, inReplyToMessageId: null, references: null, draftId: null, fromEmail: null, attachments: [],
      });
      useComposerStore.getState().closeComposer();
    });
    await flush();

    expect(win.close).not.toHaveBeenCalled();
    expect(win.onCloseRequested).toHaveBeenCalledTimes(1);
    const preventDefault = vi.fn();
    win.onCloseRequested.mock.calls[0][0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    // Unlisten is an IPC round trip; a close sent before it lands would still be blocked.
    let unlistenDone!: () => void;
    win.unlisten.mockReturnValueOnce(new Promise<void>((r) => { unlistenDone = r; }));
    act(() => useComposerStore.getState().setPendingSend(null));
    await flush();

    expect(win.unlisten).toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
    unlistenDone();
    await flush();
    expect(win.close).toHaveBeenCalled();
  });
});
