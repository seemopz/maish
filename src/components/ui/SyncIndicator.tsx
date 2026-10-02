import { Loader2, AlertCircle } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";

/**
 * Unobtrusive sync state in the bottom-left corner: a spinner while syncing, an error icon after a failure.
 * Rendered inside the sidebar's bottom bar as a flex item, so it takes its own space instead of covering a button.
 */
export function SyncIndicator() {
  const syncState = useUIStore((s) => s.syncState);
  const syncMessage = useUIStore((s) => s.syncMessage);

  if (syncState === "idle") return null;

  const isError = syncState === "error";
  const label = syncMessage ?? (isError ? "Sync failed" : "Syncing...");

  return (
    <div
      role={isError ? "alert" : "status"}
      title={label}
      className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-bg-primary border border-border-primary ${
        isError ? "text-danger" : "text-text-tertiary"
      }`}
    >
      {isError ? <AlertCircle size={14} aria-hidden="true" /> : <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      <span className="sr-only">{label}</span>
    </div>
  );
}
