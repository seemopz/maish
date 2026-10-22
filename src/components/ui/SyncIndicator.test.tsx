import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const mockTriggerSync = vi.fn();
vi.mock("@/services/gmail/syncManager", () => ({
  triggerSync: (ids: string[]) => mockTriggerSync(ids),
}));

import { SyncIndicator, SYNC_PILL_DELAY_MS, SYNC_ERROR_VISIBLE_MS } from "./SyncIndicator";
import { useUIStore } from "@/stores/uiStore";
import { useUndoStore } from "@/stores/undoStore";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore, type Account } from "@/stores/accountStore";

function account(id: string, isActive: boolean): Account {
  return { id, email: `${id}@example.com`, displayName: null, avatarUrl: null, isActive };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockTriggerSync.mockReset();
  useUIStore.setState({ syncState: "idle", syncMessage: null });
  useUndoStore.setState({ message: null });
  useComposerStore.setState({ undoSendVisible: false });
  useAccountStore.setState({ accounts: [account("a1", true), account("a2", false), account("a3", true)] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncIndicator", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<SyncIndicator />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a polite status pill with spinner and progress once a sync runs past the delay", () => {
    useUIStore.setState({ syncState: "syncing", syncMessage: "Syncing: 3/10 messages" });
    render(<SyncIndicator />);
    expect(screen.queryByRole("status")).toBeNull();

    advance(SYNC_PILL_DELAY_MS);
    const pill = screen.getByRole("status");
    expect(pill.getAttribute("aria-live")).toBe("polite");
    expect(pill.getAttribute("title")).toBe("Syncing: 3/10 messages");
    expect(pill.textContent).toBe("Syncing: 3/10 messages");
    expect(pill.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    expect(pill.className).toContain("bottom-4");

    // Progress updates the same pill.
    act(() => useUIStore.getState().setSyncState("syncing", "Syncing: 9/10 messages"));
    expect(screen.getByRole("status")).toBe(pill);
    expect(pill.textContent).toBe("Syncing: 9/10 messages");
  });

  it("never shows a sync that ends within the delay", () => {
    useUIStore.setState({ syncState: "syncing", syncMessage: "Syncing..." });
    render(<SyncIndicator />);
    advance(SYNC_PILL_DELAY_MS - 100);
    act(() => useUIStore.getState().setSyncState("idle"));
    advance(SYNC_PILL_DELAY_MS);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a failure at once with a retry for the active accounts, then fades out", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    render(<SyncIndicator />);
    const pill = screen.getByRole("status");
    expect(pill.textContent).toBe("Sync failed: timeoutRetry");
    expect(pill.querySelector("svg")?.getAttribute("class")).toContain("text-danger");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockTriggerSync).toHaveBeenCalledWith(["a1", "a3"]);

    advance(SYNC_ERROR_VISIBLE_MS);
    advance(200); // fade-out
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a further failure again after the first one faded out", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    render(<SyncIndicator />);
    advance(SYNC_ERROR_VISIBLE_MS);
    advance(200);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => useUIStore.getState().setSyncState("error", "Sync failed: login"));
    expect(screen.getByRole("status").textContent).toBe("Sync failed: loginRetry");
  });

  it("sits above a visible undo toast so the undo button stays in place", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed" });
    render(<SyncIndicator />);
    const pill = screen.getByRole("status");
    expect(pill.className).toContain("bottom-4");

    act(() => useUndoStore.setState({ message: "Archived" }));
    expect(pill.className).toContain("bottom-16");
    act(() => useUndoStore.setState({ message: null }));
    expect(pill.className).toContain("bottom-4");

    act(() => useComposerStore.setState({ undoSendVisible: true }));
    expect(pill.className).toContain("bottom-16");
  });
});
