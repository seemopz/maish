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

const pill = () => screen.queryByTestId("sync-pill");
const announced = () => screen.getByRole("status").textContent;

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setSync(state: "idle" | "syncing" | "error", message: string | null = null) {
  act(() => useUIStore.getState().setSyncState(state, message));
}

/** Show a failure and let it fade out. */
function failAndFade(message: string) {
  setSync("error", message);
  expect(pill()).not.toBeNull();
  advance(SYNC_ERROR_VISIBLE_MS);
  advance(200);
  expect(pill()).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockTriggerSync.mockReset();
  useUIStore.setState({ syncState: "idle", syncMessage: null, isSyncingFolder: null });
  useUndoStore.setState({ message: null });
  useComposerStore.setState({ undoSendVisible: false });
  useAccountStore.setState({ accounts: [account("a1", true), account("a2", false), account("a3", true)] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncIndicator", () => {
  it("renders only an empty, permanently mounted live region while idle", () => {
    render(<SyncIndicator />);
    expect(pill()).toBeNull();
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
  });

  it("shows a pill with spinner and progress once a sync runs past the delay", () => {
    useUIStore.setState({ syncState: "syncing", syncMessage: "Syncing: 3/10 messages" });
    render(<SyncIndicator />);
    const live = screen.getByRole("status");
    expect(pill()).toBeNull();

    advance(SYNC_PILL_DELAY_MS);
    const el = pill()!;
    expect(el.getAttribute("title")).toBe("Syncing: 3/10 messages");
    expect(el.textContent).toBe("Syncing: 3/10 messages");
    expect(el.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    expect(el.className).toContain("bottom-4");
    // The text goes into the region that was there before it, so it is announced.
    expect(screen.getByRole("status")).toBe(live);
    expect(live.textContent).toBe("Syncing: 3/10 messages");

    // Progress updates the same pill.
    setSync("syncing", "Syncing: 9/10 messages");
    expect(pill()).toBe(el);
    expect(el.textContent).toBe("Syncing: 9/10 messages");
  });

  it("never shows a sync that ends within the delay", () => {
    useUIStore.setState({ syncState: "syncing", syncMessage: "Syncing..." });
    render(<SyncIndicator />);
    advance(SYNC_PILL_DELAY_MS - 100);
    setSync("idle");
    advance(SYNC_PILL_DELAY_MS);
    expect(pill()).toBeNull();
  });

  it("shows a failure at once with a retry for the active accounts, then fades out", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    render(<SyncIndicator />);
    const el = pill()!;
    expect(el.textContent).toBe("Sync failed: timeoutRetry");
    expect(el.querySelector("svg")?.getAttribute("class")).toContain("text-danger");
    expect(announced()).toBe("Sync failed: timeout");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockTriggerSync).toHaveBeenCalledWith(["a1", "a3"]);

    advance(SYNC_ERROR_VISIBLE_MS);
    advance(200); // fade-out
    expect(pill()).toBeNull();
    expect(announced()).toBe("");
  });

  it("shows a different failure again after the first one faded out", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: timeout");
    setSync("syncing", "Syncing...");
    setSync("error", "Sync failed: login");
    expect(pill()!.textContent).toBe("Sync failed: loginRetry");
  });

  it("keeps a repeated failure of the background sync off screen", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: timeout");

    // The next background run (every minute) fails the same way and takes longer than the delay.
    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS * 5);
    expect(pill()).toBeNull();
    setSync("error", "Sync failed: timeout");
    expect(pill()).toBeNull();
  });

  it("shows a failure again after a sync succeeded in between", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: timeout");
    setSync("syncing", "Syncing...");
    setSync("idle");
    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS);
    expect(pill()!.textContent).toBe("Syncing...");
    setSync("error", "Sync failed: timeout");
    expect(pill()!.textContent).toBe("Sync failed: timeoutRetry");
  });

  it("shows the spinner and a repeated failure of a sync the user started", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: timeout");

    // The reload button, F5 and the folder context menu mark the folder before they sync.
    act(() => useUIStore.getState().setSyncingFolder("inbox"));
    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS);
    expect(pill()!.textContent).toBe("Syncing...");
    setSync("error", "Sync failed: timeout");
    expect(pill()!.textContent).toBe("Sync failed: timeoutRetry");
  });

  it("answers a retry with the spinner and the repeated failure", () => {
    render(<SyncIndicator />);
    setSync("error", "Sync failed: timeout");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS);
    expect(pill()!.textContent).toBe("Syncing...");
    setSync("error", "Sync failed: timeout");
    expect(pill()!.textContent).toBe("Sync failed: timeoutRetry");
  });

  it("keeps a failure on screen for its full time while the next account syncs", () => {
    render(<SyncIndicator />);
    setSync("error", "Sync failed: A");
    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS);
    // No retry while a sync runs.
    expect(pill()!.textContent).toBe("Sync failed: A");
    // The remembered error of account A comes back once account B is done.
    setSync("error", "Sync failed: A");
    expect(pill()!.textContent).toBe("Sync failed: ARetry");
    advance(SYNC_ERROR_VISIBLE_MS - SYNC_PILL_DELAY_MS);
    advance(200);
    expect(pill()).toBeNull();
  });

  it("sits above a visible undo toast so the undo button stays in place", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed" });
    render(<SyncIndicator />);
    const el = pill()!;
    expect(el.className).toContain("bottom-4");

    act(() => useUndoStore.setState({ message: "Archived" }));
    expect(el.className).toContain("bottom-16");
    act(() => useUndoStore.setState({ message: null }));
    expect(el.className).toContain("bottom-4");

    act(() => useComposerStore.setState({ undoSendVisible: true }));
    expect(el.className).toContain("bottom-16");
  });
});
