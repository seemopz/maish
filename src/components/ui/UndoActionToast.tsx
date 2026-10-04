import { useRef } from "react";
import { CSSTransition } from "react-transition-group";
import { useUndoStore } from "@/stores/undoStore";
import { undoPending, UNDO_WINDOW_MS } from "@/services/undoableActions";

/** Toast after archive, trash, spam or move; `z` or the button takes the action back. */
export function UndoActionToast() {
  const message = useUndoStore((s) => s.message);
  const token = useUndoStore((s) => s.token);
  const toastRef = useRef<HTMLDivElement>(null);
  // Keep the last text while the toast fades out.
  const lastMessage = useRef("");
  if (message) lastMessage.current = message;

  return (
    <CSSTransition nodeRef={toastRef} in={message !== null} timeout={200} classNames="toast" unmountOnExit>
      <div
        ref={toastRef}
        role="status"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-accent text-on-accent rounded-md shadow-lg overflow-hidden"
      >
        <div className="pl-4 pr-3 h-10 flex items-center gap-4">
          <span className="text-sm">{lastMessage.current}</span>
          <button
            onClick={() => void undoPending()}
            className="text-sm font-medium text-on-accent underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            Undo
          </button>
        </div>
        <div className="h-0.5 bg-on-accent/20">
          <div
            key={token}
            className="h-full bg-on-accent/70"
            style={{ animation: `countdownBar ${UNDO_WINDOW_MS / 1000}s linear forwards` }}
          />
        </div>
      </div>
    </CSSTransition>
  );
}
