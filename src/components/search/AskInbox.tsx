import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X, Send, ExternalLink } from "lucide-react";
import { askMyInbox, type AskInboxResult } from "@/services/ai/askInbox";
import { AiError } from "@/services/ai/errors";
import { useAccountStore } from "@/stores/accountStore";
import { navigateToLabel } from "@/router/navigate";

interface AskInboxProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AskInbox({ isOpen, onClose }: AskInboxProps) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskInboxResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const handleAsk = useCallback(async () => {
    if (!question.trim() || !activeAccountId || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await askMyInbox(question.trim(), activeAccountId);
      setResult(res);
    } catch (err) {
      console.error("Ask inbox failed:", err);
      setResult({
        answer: err instanceof AiError && err.code === "NOT_CONFIGURED"
          ? err.message
          : "Sorry, something went wrong. Please check your AI configuration and try again.",
        sourceMessages: [],
      });
    } finally {
      setLoading(false);
    }
  }, [question, activeAccountId, loading]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAsk();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [handleAsk, onClose],
  );

  const handleNavigateToThread = useCallback((threadId: string) => {
    navigateToLabel("all", { threadId });
    onClose();
  }, [onClose]);

  const handleClear = useCallback(() => {
    setQuestion("");
    setResult(null);
    inputRef.current?.focus();
  }, []);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 overlay-backdrop" onClick={onClose} />
      <div className="relative bg-bg-primary border border-border-primary rounded-lg surface-overlay w-full max-w-lg overflow-hidden flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center gap-2 h-10 pl-4 pr-2 border-b border-border-primary bg-bg-secondary">
          <Sparkles size={14} className="text-text-tertiary" />
          <span className="text-sm font-medium text-text-primary flex-1">Ask My Inbox</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 h-12 pl-4 pr-2 border-b border-border-primary">
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your emails..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <button
            onClick={handleAsk}
            disabled={!question.trim() || loading}
            className="p-1.5 rounded-md text-text-primary hover:bg-bg-hover disabled:text-text-tertiary disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-6 text-text-tertiary justify-center">
              <div className="w-4 h-4 border-2 border-border-primary border-t-text-primary rounded-full animate-spin" />
              <span className="text-sm">Searching your inbox...</span>
            </div>
          )}

          {result && (
            <div className="p-4 space-y-4">
              {/* Answer */}
              <div className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
                {result.answer}
              </div>

              {/* Source messages */}
              {result.sourceMessages.length > 0 && (
                <div>
                  <div className="label-mono mb-1.5">
                    Sources ({result.sourceMessages.length})
                  </div>
                  <div className="space-y-0.5">
                    {result.sourceMessages.slice(0, 5).map((msg) => (
                      <button
                        key={msg.message_id}
                        onClick={() => handleNavigateToThread(msg.thread_id)}
                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-bg-hover transition-colors group"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] font-medium text-text-primary truncate">
                            {msg.from_name ?? msg.from_address ?? "Unknown"}
                          </span>
                          <span className="font-mono text-xs tabular-nums text-text-tertiary shrink-0 ml-2">
                            {new Date(msg.date).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="text-xs text-text-secondary truncate mt-0.5 flex items-center gap-1">
                          {msg.subject ?? "(no subject)"}
                          <ExternalLink size={12} className="text-text-tertiary opacity-0 group-hover:opacity-100 shrink-0" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Ask again */}
              <button
                onClick={handleClear}
                className="text-xs text-text-secondary hover:text-text-primary underline underline-offset-2 decoration-border-primary hover:decoration-text-tertiary transition-colors"
              >
                Ask another question
              </button>
            </div>
          )}

          {!loading && !result && (
            <div className="px-4 py-8 text-center text-sm text-text-tertiary">
              Ask anything about your emails — meetings, conversations, attachments, and more.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
