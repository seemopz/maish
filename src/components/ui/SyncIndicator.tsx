import { useEffect, useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { Loader2, AlertCircle } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useUndoStore } from "@/stores/undoStore";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { triggerSync } from "@/services/gmail/syncManager";

/** A sync shorter than this never shows the pill, so the background delta sync every minute does not flash it. */
export const SYNC_PILL_DELAY_MS = 1_000;
/** How long a failed sync stays on screen; the reload button next to the folder name keeps the error afterwards. */
export const SYNC_ERROR_VISIBLE_MS = 8_000;

/**
 * Sync state as a pill at the bottom centre, where the undo toasts appear: a spinner with the progress
 * while a sync runs, the error with a retry button after a failure. Idle renders nothing.
 * While an undo toast is visible the pill sits above it, so the undo button never moves.
 */
export function SyncIndicator() {
  const syncState = useUIStore((s) => s.syncState);
  const syncMessage = useUIStore((s) => s.syncMessage);
  const undoVisible = useUndoStore((s) => s.message !== null);
  const undoSendVisible = useComposerStore((s) => s.undoSendVisible);
  const [visible, setVisible] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);

  // A new error message restarts its timer; a progress update does not restart the delay.
  const errorMessage = syncState === "error" ? syncMessage : null;
  useEffect(() => {
    if (syncState === "idle") {
      setVisible(false);
      return;
    }
    if (syncState === "error") {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), SYNC_ERROR_VISIBLE_MS);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setVisible(true), SYNC_PILL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [syncState, errorMessage]);

  // Keep the last content while the pill fades out.
  const last = useRef({ isError: false, label: "" });
  if (syncState !== "idle") {
    const isError = syncState === "error";
    last.current = { isError, label: syncMessage ?? (isError ? "Sync failed" : "Syncing...") };
  }
  const { isError, label } = last.current;

  const handleRetry = () => {
    const ids = useAccountStore.getState().accounts.filter((a) => a.isActive).map((a) => a.id);
    if (ids.length > 0) void triggerSync(ids);
  };

  return (
    <CSSTransition nodeRef={pillRef} in={visible} timeout={200} classNames="toast" unmountOnExit>
      <div
        ref={pillRef}
        role="status"
        aria-live="polite"
        title={label}
        className={`fixed left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] h-8 pl-3 pr-3 flex items-center gap-2 rounded-full bg-bg-primary border border-border-primary shadow-lg text-xs text-text-secondary transition-[bottom] duration-200 ${
          undoVisible || undoSendVisible ? "bottom-16" : "bottom-4"
        }`}
      >
        {isError ? (
          <AlertCircle size={14} className="shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Loader2 size={14} className="shrink-0 animate-spin text-text-tertiary" aria-hidden="true" />
        )}
        <span className="truncate">{label}</span>
        {isError && (
          <button
            type="button"
            onClick={handleRetry}
            className="shrink-0 font-medium text-accent hover:text-accent-hover transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    </CSSTransition>
  );
}
