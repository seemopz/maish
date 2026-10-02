import type { SyncState } from "@/stores/uiStore";

export interface SyncDisplay {
  state: SyncState;
  message: string | null;
}

/**
 * Fold one account's sync event into the state shown to the user.
 *
 * Accounts sync one after another, so a failure must outlive the accounts that
 * follow it: `errors` remembers the last failure per account and an account's
 * entry is dropped only when that account starts or finishes a sync again.
 * While any sync runs the spinner wins; once none runs, a remembered error shows.
 */
export function nextSyncDisplay(
  errors: Map<string, string>,
  accountId: string,
  status: "syncing" | "done" | "error",
  message: string | null,
): SyncDisplay {
  if (status === "error") {
    errors.set(accountId, message ?? "Sync failed");
    return { state: "error", message: errors.get(accountId) ?? null };
  }
  errors.delete(accountId);
  if (status === "syncing") return { state: "syncing", message };
  const remaining = [...errors.values()];
  if (remaining.length > 0) return { state: "error", message: remaining[remaining.length - 1] ?? null };
  return { state: "idle", message: null };
}
