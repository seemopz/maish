import { Loader2, AlertCircle } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";

/** Unobtrusive sync state in the bottom-left corner: a spinner while syncing, an error icon after a failure. */
export function SyncIndicator() {
  const syncState = useUIStore((s) => s.syncState);
  const syncMessage = useUIStore((s) => s.syncMessage);

  if (syncState === "idle") return null;

  const isError = syncState === "error";
  const label = syncMessage ?? (isError ? "Sync failed" : "Syncing...");

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className={`fixed bottom-2 left-2 z-40 flex items-center justify-center w-6 h-6 rounded-full bg-bg-primary border border-border-primary shadow-sm ${
        isError ? "text-danger" : "text-text-tertiary"
      }`}
    >
      {isError ? <AlertCircle size={14} /> : <Loader2 size={14} className="animate-spin" />}
    </div>
  );
}
