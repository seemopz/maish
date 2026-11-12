import { useRef } from "react";
import { CSSTransition } from "react-transition-group";
import { useComposerStore } from "@/stores/composerStore";

export function UndoSendToast() {
  const {
    undoSendVisible,
    undoSendTimer,
    pendingSend,
    setUndoSendTimer,
    setUndoSendVisible,
    setPendingSend,
    openComposer,
  } = useComposerStore();
  const toastRef = useRef<HTMLDivElement>(null);

  const handleUndo = () => {
    if (undoSendTimer) {
      clearTimeout(undoSendTimer);
      setUndoSendTimer(null);
    }
    setUndoSendVisible(false);

    // Cancelling a send should give the mail back, not throw it away.
    // handleSend closed the composer as soon as the timer was scheduled, so
    // this snapshot is the only copy of what was written.
    if (pendingSend) {
      openComposer({
        mode: pendingSend.mode,
        to: pendingSend.to,
        cc: pendingSend.cc,
        bcc: pendingSend.bcc,
        subject: pendingSend.subject,
        bodyHtml: pendingSend.bodyHtml,
        threadId: pendingSend.threadId,
        inReplyToMessageId: pendingSend.inReplyToMessageId,
        references: pendingSend.references,
        draftId: pendingSend.draftId,
        fromEmail: pendingSend.fromEmail,
        attachments: pendingSend.attachments,
      });
      setPendingSend(null);
    }
  };

  return (
    <CSSTransition nodeRef={toastRef} in={undoSendVisible} timeout={200} classNames="toast" unmountOnExit>
      <div ref={toastRef} className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-accent text-on-accent rounded-md shadow-lg overflow-hidden">
        <div className="pl-4 pr-3 h-10 flex items-center gap-4">
          <span className="text-sm">Sending email...</span>
          <button
            onClick={handleUndo}
            className="text-sm font-medium text-on-accent underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            Undo
          </button>
        </div>
        <div className="h-0.5 bg-on-accent/20">
          <div
            className="h-full bg-on-accent/70"
            style={{ animation: `countdownBar ${pendingSend?.delaySeconds ?? 5}s linear forwards` }}
          />
        </div>
      </div>
    </CSSTransition>
  );
}
