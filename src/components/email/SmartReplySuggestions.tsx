import { useState, useCallback, useRef, useEffect } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { isAiAvailable } from "@/services/ai/providerManager";
import { generateSmartReplies, SMART_REPLIES_CACHE } from "@/services/ai/aiService";
import { deleteAiCache } from "@/services/db/aiCache";
import { useComposerStore } from "@/stores/composerStore";
import type { DbMessage } from "@/services/db/messages";

interface SmartReplySuggestionsProps {
  threadId: string;
  accountId: string;
  messages: DbMessage[];
  noReply?: boolean;
}

export function SmartReplySuggestions({ threadId, accountId, messages, noReply }: SmartReplySuggestionsProps) {
  const [replies, setReplies] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(false);
  const checkedRef = useRef(false);
  const loadingRef = useRef(false);
  const openComposer = useComposerStore((s) => s.openComposer);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    isAiAvailable().then(setAvailable);
  }, []);

  const loadReplies = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await generateSmartReplies(threadId, accountId, messages);
      setReplies(result);
    } catch (err) {
      console.error("Failed to generate smart replies:", err);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  // Auto-load when available
  useEffect(() => {
    if (!available || messages.length === 0 || replies !== null || loadingRef.current) return;
    loadReplies();
  }, [available, messages.length, replies, loadReplies]);

  const handleRefresh = useCallback(async () => {
    await deleteAiCache(accountId, threadId, SMART_REPLIES_CACHE);
    setReplies(null);
    setLoading(true);
    try {
      const result = await generateSmartReplies(threadId, accountId, messages);
      setReplies(result);
    } catch (err) {
      console.error("Failed to refresh smart replies:", err);
    } finally {
      setLoading(false);
    }
  }, [threadId, accountId, messages]);

  const handleReplyClick = useCallback((replyText: string) => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return;

    const replyTo = lastMessage.reply_to ?? lastMessage.from_address;
    openComposer({
      mode: "reply",
      to: replyTo ? [replyTo] : [],
      subject: `Re: ${lastMessage.subject ?? ""}`,
      bodyHtml: `<p>${replyText}</p>`,
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
    });
  }, [messages, openComposer]);

  if (!available || messages.length === 0 || noReply) return null;

  return (
    <div className="mx-4 my-2 px-3 py-2.5 rounded-md border border-border-primary bg-bg-secondary">
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles size={12} className="text-text-tertiary shrink-0" />
        <span className="label-mono flex-1">Quick Replies</span>
        <button
          onClick={handleRefresh}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Refresh suggestions"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {loading && !replies && (
        <div className="flex items-center gap-2 text-text-tertiary">
          <div className="w-3 h-3 border-2 border-border-primary border-t-text-secondary rounded-full animate-spin" />
          <span className="font-mono text-xs">Generating suggestions...</span>
        </div>
      )}
      {replies && (
        <div className="flex flex-wrap gap-2">
          {replies.map((reply, i) => (
            <button
              key={i}
              onClick={() => handleReplyClick(reply)}
              className="h-7 px-3 text-[13px] text-text-primary bg-bg-primary border border-border-primary rounded-full hover:bg-bg-hover transition-colors max-w-[280px] truncate"
              title={reply}
            >
              {reply}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
