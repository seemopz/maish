import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const mockTriggerSync = vi.fn();
const syncRequestListeners = new Set<(settled: Promise<void>) => void>();
/**
 * What syncManager does for every sync that is asked for (not the background timer).
 * Returns the function that ends the requested run, queued or not.
 */
function requestSync(): () => Promise<void> {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  act(() => syncRequestListeners.forEach((cb) => cb(settled)));
  return () =>
    act(async () => {
      settle();
      await settled;
    });
}
vi.mock("@/services/gmail/syncManager", () => ({
  triggerSync: (ids: string[]) => {
    syncRequestListeners.forEach((cb) => cb(new Promise<void>(() => {})));
    mockTriggerSync(ids);
  },
  onSyncRequested: (cb: (settled: Promise<void>) => void) => {
    syncRequestListeners.add(cb);
    return () => syncRequestListeners.delete(cb);
  },
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
  useUIStore.setState({ syncState: "idle", syncMessage: null });
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

  it("keeps the repeated failures of two accounts off screen once each was shown", () => {
    render(<SyncIndicator />);
    const shown: string[] = [];
    const record = () => {
      const text = pill()?.textContent;
      if (text && shown[shown.length - 1] !== text) shown.push(text);
    };
    for (let minute = 0; minute < 3; minute++) {
      // The order nextSyncDisplay() reports: each account's own error, then the last remembered one.
      setSync("syncing", "Syncing...");
      advance(SYNC_PILL_DELAY_MS * 2);
      record();
      setSync("error", "Sync failed: A");
      record();
      setSync("syncing", "Syncing...");
      advance(SYNC_PILL_DELAY_MS * 2);
      record();
      setSync("error", "Sync failed: B");
      record();
      advance(60_000);
      record();
    }
    expect(shown).toEqual(["Syncing...", "Sync failed: ARetry", "Sync failed: A", "Sync failed: BRetry"]);
  });

  it("shows the spinner and a repeated failure of a sync that was asked for", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: timeout");

    // Reload button, F5, context menu, tray, settings, a new account's first sync, back online.
    requestSync();
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

  it("shows the spinner of a requested sync that waited behind a failing background run", () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: A");

    // The background run of account A is under way when a new account B is added; B is queued.
    setSync("syncing", "Syncing...");
    requestSync();
    setSync("error", "Sync failed: A");
    setSync("syncing", "Syncing: 10/5000 messages");
    advance(30_000);
    expect(pill()!.textContent).toBe("Syncing: 10/5000 messages");
  });

  it("keeps the background repeats hidden again once the requested run is over", async () => {
    render(<SyncIndicator />);
    failAndFade("Sync failed: A");
    const settle = requestSync();
    setSync("syncing", "Syncing...");
    setSync("error", "Sync failed: A");
    advance(SYNC_ERROR_VISIBLE_MS);
    advance(200);
    await settle();

    setSync("syncing", "Syncing...");
    advance(SYNC_PILL_DELAY_MS * 5);
    expect(pill()).toBeNull();
    setSync("error", "Sync failed: A");
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
