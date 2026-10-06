import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies needed for the hook to mount and dispatch events.
// The hook reads store state and calls navigate/emailActions — only mock
// what's needed for the three event-dispatch tests below.
vi.mock("@/stores/uiStore", () => ({
  useUIStore: { getState: () => ({ inboxViewMode: "unified", toggleSidebar: vi.fn() }) },
}));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: () => ({
      threads: [],
      selectedThreadIds: new Set(),
      removeThread: vi.fn(),
      removeThreads: vi.fn(),
      updateThread: vi.fn(),
      clearMultiSelect: vi.fn(),
      selectAll: vi.fn(),
      selectAllFromHere: vi.fn(),
    }),
  },
}));
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => ({ isOpen: false, openComposer: vi.fn(), closeComposer: vi.fn() }) },
}));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: { getState: () => ({ activeAccountId: null }) },
}));
const shortcuts = vi.hoisted(() => ({
  keyMap: {} as Record<string, string>,
}));
const defaultKeyMap = () => ({
  "app.askInbox": "i",
  "app.commandPalette": "/",
  "app.toggleSidebar": "Ctrl+Shift+E",
  "app.help": "?",
  "action.undo": "z",
});
vi.mock("@/stores/shortcutStore", () => ({
  useShortcutStore: { getState: () => ({ keyMap: shortcuts.keyMap }) },
}));
vi.mock("@/stores/contextMenuStore", () => ({
  useContextMenuStore: { getState: () => ({ menuType: null, closeMenu: vi.fn() }) },
}));
vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: () => "inbox",
  getSelectedThreadId: () => null,
}));
vi.mock("@/services/emailActions", () => ({
  archiveThread: vi.fn(),
  trashThread: vi.fn(),
  permanentDeleteThread: vi.fn(),
  starThread: vi.fn(),
  spamThread: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  deleteThread: vi.fn(),
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  muteThread: vi.fn(),
  unmuteThread: vi.fn(),
}));
vi.mock("@/services/gmail/draftDeletion", () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("@/components/email/MessageItem", () => ({ parseUnsubscribeUrl: vi.fn() }));
vi.mock("@/services/undoableActions", () => ({ undoPending: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/services/gmail/syncManager", () => ({ triggerSync: vi.fn() }));

import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { undoPending } from "@/services/undoableActions";

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shortcuts.keyMap = defaultKeyMap();
  });

  it("never fires a custom binding on the reserved zoom keys", () => {
    shortcuts.keyMap = { ...defaultKeyMap(), "action.undo": "Ctrl+0" };
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true }));

    expect(undoPending).not.toHaveBeenCalled();
  });

  it("still fires custom Ctrl combinations that are not reserved", () => {
    shortcuts.keyMap = { ...defaultKeyMap(), "action.undo": "Ctrl+9" };
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "9", ctrlKey: true, bubbles: true }));

    expect(undoPending).toHaveBeenCalledTimes(1);
  });

  it("dispatches maish-toggle-ask-inbox when 'i' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("maish-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("maish-toggle-ask-inbox", listener);
  });

  it("undoes the last archive / delete / spam / move when 'z' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));

    expect(undoPending).toHaveBeenCalledTimes(1);
  });

  it("dispatches maish-toggle-command-palette when '/' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("maish-toggle-command-palette", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("maish-toggle-command-palette", listener);
  });

  it("dispatches maish-toggle-shortcuts-help when '?' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("maish-toggle-shortcuts-help", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("maish-toggle-shortcuts-help", listener);
  });
});
