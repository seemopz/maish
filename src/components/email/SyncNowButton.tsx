import { RefreshCw } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { triggerSync } from "@/services/gmail/syncManager";

/**
 * Reload button next to the folder name: starts a sync for the active account and spins while one runs.
 * While the last sync has failed it is red with the error as its tooltip, and a click syncs all active
 * accounts like the pill's Retry, because the failure may belong to an account other than the active one.
 */
export function SyncNowButton() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeLabel = useActiveLabel();
  const isSyncing = useUIStore((s) => s.syncState === "syncing");
  const error = useUIStore((s) => (s.syncState === "error" ? s.syncMessage ?? "Sync failed" : null));

  const handleClick = () => {
    if (!activeAccountId || isSyncing) return;
    useUIStore.getState().setSyncingFolder(activeLabel);
    const ids = error
      ? useAccountStore.getState().accounts.filter((a) => a.isActive).map((a) => a.id)
      : [activeAccountId];
    triggerSync(ids);
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
