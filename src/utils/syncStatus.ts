import type { SyncState } from "@/stores/uiStore";
import type { SyncProgress } from "@/services/gmail/sync";

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
 * "removed" (the account was deleted) forgets the entry like "done" does.
 * While any sync runs the spinner wins; once none runs, a remembered error shows.
 *
 * `syncing` tracks which accounts are mid-sync. "removed" arrives from the
 * settings page, outside the sync loop, so it returns `null` (leave the display
 * as it is) while a different account is still syncing.
 */
export function nextSyncDisplay(
  errors: Map<string, string>,
  accountId: string,
  status: "syncing" | "done" | "error" | "removed",
  message: string | null,
  syncing: Set<string> = new Set(),
): SyncDisplay | null {
  if (status === "syncing") syncing.add(accountId);
  else syncing.delete(accountId);
  if (status === "removed" && syncing.size > 0) {
    errors.delete(accountId);
    return null;
  }
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

/** The line shown while a sync runs; `progress` is absent until the first phase reports. */
export function syncProgressMessage(progress?: SyncProgress): string {
  if (progress?.phase === "messages") return `Syncing: ${progress.current}/${progress.total} messages`;
  if (progress?.phase === "labels") return "Syncing labels...";
  if (progress?.phase === "threads") return `Building threads... (${progress.current}/${progress.total})`;
  return "Syncing...";
}
