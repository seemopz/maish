import { RefreshCw } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { triggerSync } from "@/services/gmail/syncManager";

/**
 * Reload button next to the folder name: starts a sync for the active account and spins while one runs.
 * After a failed sync it turns red and carries the error as its tooltip, once the sync pill has faded out.
 */
export function SyncNowButton() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeLabel = useActiveLabel();
  const isSyncing = useUIStore((s) => s.syncState === "syncing");
  const error = useUIStore((s) => (s.syncState === "error" ? s.syncMessage ?? "Sync failed" : null));

  const handleClick = () => {
    if (!activeAccountId || isSyncing) return;
    useUIStore.getState().setSyncingFolder(activeLabel);
    triggerSync([activeAccountId]);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!activeAccountId || isSyncing}
      title={error ? `${error} – Sync now` : "Sync now"}
      aria-label="Sync now"
      className={`p-1 rounded-md ${error ? "text-danger" : "text-text-tertiary"} hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-tertiary disabled:cursor-default`}
    >
      <RefreshCw size={13} className={isSyncing ? "animate-spin" : undefined} />
    </button>
  );
}
