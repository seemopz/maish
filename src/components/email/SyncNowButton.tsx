import { RefreshCw } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { triggerSync } from "@/services/gmail/syncManager";

/** Reload button next to the folder name: starts a sync for the active account and spins while one runs. */
export function SyncNowButton() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeLabel = useActiveLabel();
  const isSyncing = useUIStore((s) => s.syncState === "syncing");

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
      title="Sync now"
      aria-label="Sync now"
      className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-tertiary disabled:cursor-default"
    >
      <RefreshCw size={13} className={isSyncing ? "animate-spin" : undefined} />
    </button>
  );
}
