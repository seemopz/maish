import { useEffect, useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { Loader2, AlertCircle } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { useUndoStore } from "@/stores/undoStore";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { triggerSync, onSyncRequested } from "@/services/gmail/syncManager";

/** A sync shorter than this never shows the pill, so the background delta sync every minute does not flash it. */
export const SYNC_PILL_DELAY_MS = 1_000;
/** How long a failed sync stays on screen; the reload button next to the folder name keeps the error afterwards. */
export const SYNC_ERROR_VISIBLE_MS = 8_000;

/**
 * Sync state as a pill at the bottom centre, where the undo toasts appear: a spinner with the progress
 * while a sync runs, the error with a retry button after a failure. Idle renders nothing.
 * While an undo toast is visible the pill sits above it, so the undo button never moves.
 *
 * The background sync retries every minute without checking whether it can succeed, so each failure is
 * shown once: until a sync succeeds, the errors already shown and the spinner of the runs that repeat
 * them stay off screen (the reload button stays red). Errors are remembered as a set, because with two
 * failing accounts the message alternates between them. A sync that was asked for (by the user, for a
 * new account, on reconnect; see `onSyncRequested`) shows both again.
 */
export function SyncIndicator() {
  const syncState = useUIStore((s) => s.syncState);
  const syncMessage = useUIStore((s) => s.syncMessage);
  const undoVisible = useUndoStore((s) => s.message !== null);
  const undoSendVisible = useComposerStore((s) => s.undoSendVisible);
  const [shownError, setShownError] = useState<{ message: string } | null>(null);
  const [spinnerShown, setSpinnerShown] = useState(false);
  const seenErrors = useRef(new Set<string>());
  // Requested runs not yet over; their spinner shows even when it waited behind a failing background run.
  const openRequests = useRef(0);
  const pillRef = useRef<HTMLDivElement>(null);

  const forgetErrors = () => {
    seenErrors.current.clear();
    setShownError(null);
  };

  // syncManager reports the request before the sync's first status, so the set is empty by then.
  useEffect(
    () =>
      onSyncRequested((settled) => {
        forgetErrors();
        openRequests.current++;
        void settled.then(() => {
          openRequests.current--;
        });
      }),
    [],
  );

  // A progress update does not restart the delay.
  const errorMessage = syncState === "error" ? (syncMessage ?? "Sync failed") : null;
  useEffect(() => {
    if (syncState === "idle") {
      forgetErrors();
      setSpinnerShown(false);
      return;
    }
    if (errorMessage !== null) {
      setSpinnerShown(false);
      if (!seenErrors.current.has(errorMessage)) {
        seenErrors.current.add(errorMessage);
        setShownError({ message: errorMessage });
      }
      return;
    }
    if (seenErrors.current.size > 0 && openRequests.current === 0) return;
    const timer = setTimeout(() => setSpinnerShown(true), SYNC_PILL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [syncState, errorMessage]);

  // An error stays for its full time, even while another account syncs after it.
  useEffect(() => {
    if (!shownError) return;
    const timer = setTimeout(() => setShownError(null), SYNC_ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [shownError]);

  const visible = shownError !== null || spinnerShown;
  // Keep the last content while the pill fades out.
  const last = useRef({ isError: false, label: "" });
  if (shownError) last.current = { isError: true, label: shownError.message };
  else if (spinnerShown) last.current = { isError: false, label: syncMessage ?? "Syncing..." };
  const { isError, label } = last.current;

  const handleRetry = () => {
    const ids = useAccountStore.getState().accounts.filter((a) => a.isActive).map((a) => a.id);
    if (ids.length > 0) void triggerSync(ids);
  };

  return (
    <>
      {/* Mounted for good: screen readers do not announce a live region inserted together with its text. */}
      <div role="status" aria-live="polite" className="sr-only">
        {visible ? label : ""}
      </div>
      <CSSTransition nodeRef={pillRef} in={visible} timeout={200} classNames="toast" unmountOnExit>
        <div
          ref={pillRef}
          data-testid="sync-pill"
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
          <span className="truncate" aria-hidden="true">{label}</span>
          {isError && syncState !== "syncing" && (
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
    </>
  );
}
