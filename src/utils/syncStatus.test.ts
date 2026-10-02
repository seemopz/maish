import { describe, it, expect } from "vitest";
import { nextSyncDisplay } from "./syncStatus";

describe("nextSyncDisplay", () => {
  it("goes idle when a sync finishes cleanly", () => {
    const errors = new Map<string, string>();
    expect(nextSyncDisplay(errors, "a", "syncing", "Syncing...")).toEqual({ state: "syncing", message: "Syncing..." });
    expect(nextSyncDisplay(errors, "a", "done", null)).toEqual({ state: "idle", message: null });
  });

  it("keeps account A's failure visible after account B syncs successfully", () => {
    const errors = new Map<string, string>();
    nextSyncDisplay(errors, "a", "syncing", "Syncing...");
    expect(nextSyncDisplay(errors, "a", "error", "Sync failed: A")).toEqual({ state: "error", message: "Sync failed: A" });
    expect(nextSyncDisplay(errors, "b", "syncing", "Syncing...").state).toBe("syncing");
    expect(nextSyncDisplay(errors, "b", "done", null)).toEqual({ state: "error", message: "Sync failed: A" });
  });

  it("clears an account's failure once that account syncs again", () => {
    const errors = new Map<string, string>();
    nextSyncDisplay(errors, "a", "error", "Sync failed: A");
    nextSyncDisplay(errors, "a", "syncing", "Syncing...");
    expect(nextSyncDisplay(errors, "a", "done", null)).toEqual({ state: "idle", message: null });
  });

  it("falls back to a generic message", () => {
    expect(nextSyncDisplay(new Map(), "a", "error", null)).toEqual({ state: "error", message: "Sync failed" });
  });

  it("forgets a removed account's failure", () => {
    const errors = new Map<string, string>();
    nextSyncDisplay(errors, "a", "error", "Sync failed: A");
    expect(nextSyncDisplay(errors, "a", "removed", null)).toEqual({ state: "idle", message: null });
  });

  it("keeps another account's failure when a different account is removed", () => {
    const errors = new Map<string, string>();
    nextSyncDisplay(errors, "a", "error", "Sync failed: A");
    expect(nextSyncDisplay(errors, "b", "removed", null)).toEqual({ state: "error", message: "Sync failed: A" });
  });
});
