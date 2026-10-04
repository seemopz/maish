import { memo, useMemo, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { formatRelativeDate } from "@/utils/date";
import { Paperclip, Star, Check, Pin, BellRing, VolumeX, Archive, Trash2, MailOpen, Clock, Ban } from "lucide-react";
import { useSwipeGesture, type SwipeDirection } from "@/hooks/useSwipeGesture";
import { resolveSwipeAction, describeSwipeAction, type SwipeAction } from "@/utils/swipeActions";
import { runSwipeAction } from "@/services/swipeActions";
import { snoozeThread } from "@/services/snooze/snoozeManager";
import { SnoozeDialog } from "./SnoozeDialog";
import type { ReactNode } from "react";
import type { DragData } from "@/components/dnd/DndProvider";

const BADGE_CATEGORIES = new Set(["Updates", "Promotions", "Social", "Newsletters"]);

const SWIPE_VISUALS: Record<Exclude<SwipeAction, "none">, { bg: string; icon: ReactNode }> = {
  trash: { bg: "bg-danger", icon: <Trash2 size={16} /> },
  spam: { bg: "bg-danger", icon: <Ban size={16} /> },
  archive: { bg: "bg-success", icon: <Archive size={16} /> },
  snooze: { bg: "bg-warning", icon: <Clock size={16} /> },
  star: { bg: "bg-warning", icon: <Star size={16} /> },
  toggleRead: { bg: "bg-accent", icon: <MailOpen size={16} /> },
};

interface ThreadCardProps {
  thread: Thread;
  isSelected: boolean;
  onClick: (thread: Thread) => void;
  onContextMenu?: (e: React.MouseEvent, threadId: string) => void;
  category?: string;
  showCategoryBadge?: boolean;
  hasFollowUp?: boolean;
}

export const ThreadCard = memo(function ThreadCard({ thread, isSelected, onClick, onContextMenu, category, showCategoryBadge, hasFollowUp }: ThreadCardProps) {
  const isMultiSelected = useThreadStore((s) => s.selectedThreadIds.has(thread.id));
  const hasMultiSelect = useThreadStore((s) => s.selectedThreadIds.size > 0);
  const toggleThreadSelection = useThreadStore((s) => s.toggleThreadSelection);
  const selectThreadRange = useThreadStore((s) => s.selectThreadRange);
  const activeLabel = useActiveLabel();
  const emailDensity = useUIStore((s) => s.emailDensity);
  const isSpam = thread.labelIds.includes("SPAM");
  const removeThread = useThreadStore((s) => s.removeThread);
  const swipeLeft = resolveSwipeAction(useUIStore((s) => s.swipeLeftAction), activeLabel);
  const swipeRight = resolveSwipeAction(useUIStore((s) => s.swipeRightAction), activeLabel);
  const swipeRef = useRef<HTMLDivElement>(null);
  const [showSnooze, setShowSnooze] = useState(false);

  // Read selectedThreadIds lazily for drag — avoids subscribing all cards to the Set reference
  const dragData: DragData = useMemo(() => ({
    threadIds: hasMultiSelect && isMultiSelected
      ? [...useThreadStore.getState().selectedThreadIds]
      : [thread.id],
    sourceLabel: activeLabel,
  }), [hasMultiSelect, isMultiSelected, thread.id, activeLabel]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `thread-${thread.id}`,
    data: dragData,
  });

  // Two-finger trackpad swipe; a single thread only, never over a multi-selection or a drag.
  const { offset, armed } = useSwipeGesture(swipeRef, {
    enabled: !hasMultiSelect && !isDragging,
    allowLeft: swipeLeft !== "none",
    allowRight: swipeRight !== "none",
    onCommit: (direction: SwipeDirection) => {
      const action = direction === "left" ? swipeLeft : swipeRight;
      if (action === "snooze") setShowSnooze(true);
      else void runSwipeAction(action, thread);
    },
  });
  const swipeAction = offset < 0 ? swipeLeft : swipeRight;
  const swipeVisual = offset !== 0 && swipeAction !== "none" ? SWIPE_VISUALS[swipeAction] : null;

  const handleSnooze = async (until: number) => {
    setShowSnooze(false);
    try {
      await snoozeThread(thread.accountId, thread.id, until);
      removeThread(thread.id);
    } catch (err) {
      console.error("Failed to snooze:", err);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      selectThreadRange(thread.id);
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleThreadSelection(thread.id);
    } else if (hasMultiSelect) {
      toggleThreadSelection(thread.id);
    } else {
      onClick(thread);
    }
  };

  const handleContextMenu = onContextMenu
    ? (e: React.MouseEvent) => onContextMenu(e, thread.id)
    : undefined;
  const initial = (
    thread.fromName?.[0] ??
    thread.fromAddress?.[0] ??
    "?"
  ).toUpperCase();

  return (
    <div ref={swipeRef} className="relative overflow-hidden">
      {swipeVisual && (
        <div
          aria-hidden="true"
          data-testid="swipe-field"
          className={`absolute inset-0 flex items-center px-5 ${swipeVisual.bg} ${
            offset > 0 ? "justify-start" : "justify-end"
          }`}
        >
          <div
            className={`flex items-center gap-2 text-xs font-medium text-on-accent transition-opacity ${
              armed ? "opacity-100" : "opacity-60"
            }`}
          >
            {swipeVisual.icon}
            {describeSwipeAction(swipeAction, thread)}
          </div>
        </div>
      )}
      <button
        ref={setNodeRef}
        style={
          offset !== 0
            ? { transform: `translateX(${offset}px)`, backgroundColor: "var(--color-bg-primary)" }
            : undefined
        }
        {...attributes}
        {...listeners}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        aria-label={`${thread.isRead ? "" : "Unread "}email from ${thread.fromName ?? thread.fromAddress ?? "Unknown"}: ${thread.subject ?? "(No subject)"}`}
        aria-selected={isSelected}
        className={`w-full text-left border-b border-border-secondary group hover-lift ${
          emailDensity === "compact" ? "px-3 py-1.5" : emailDensity === "spacious" ? "px-4 py-4" : "px-4 py-3"
        } ${
          isDragging
            ? "opacity-50"
            : isMultiSelected
              ? "bg-bg-selected"
              : isSelected
                ? "bg-bg-selected shadow-[inset_2px_0_0_var(--color-text-primary)]"
                : "hover:bg-bg-hover"
        } ${isSpam ? "bg-danger/5" : ""}`}
      >
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div
            className={`rounded-full flex items-center justify-center shrink-0 font-medium ${
              emailDensity === "compact" ? "w-6 h-6 text-[11px]" : emailDensity === "spacious" ? "w-9 h-9 text-sm" : "w-8 h-8 text-xs"
            } ${
              isMultiSelected || !thread.isRead
                ? "bg-accent text-on-accent"
                : "bg-bg-tertiary text-text-secondary border border-border-primary"
            }`}
          >
            {isMultiSelected ? <Check size={emailDensity === "compact" ? 14 : 16} /> : initial}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* First row: sender + date */}
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-sm truncate ${
                  thread.isRead
                    ? "text-text-secondary"
                    : "font-medium text-text-primary"
                }`}
              >
                {thread.fromName ?? thread.fromAddress ?? "Unknown"}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-text-tertiary whitespace-nowrap shrink-0">
                {formatRelativeDate(thread.lastMessageAt)}
              </span>
            </div>

            {/* Subject */}
            <div
              className={`text-[13px] truncate mt-0.5 ${
                thread.isRead ? "text-text-secondary" : "text-text-primary"
              }`}
            >
              {thread.subject ?? "(No subject)"}
            </div>

            {/* Snippet + indicators */}
            <div className={`flex items-center gap-1.5 mt-0.5 ${emailDensity === "compact" ? "hidden" : ""}`}>
              <span className="text-xs text-text-tertiary truncate flex-1">
                {thread.snippet}
              </span>
              {showCategoryBadge && category && category !== "Primary" && BADGE_CATEGORIES.has(category) && (
                <span className="shrink-0 font-mono text-[10px] leading-4 uppercase tracking-wide px-1.5 rounded-full border border-border-primary text-text-tertiary">
                  {category}
                </span>
              )}
              {hasFollowUp && (
                <span className="shrink-0 text-text-secondary" title="Follow-up reminder set">
                  <BellRing size={12} />
                </span>
              )}
              {thread.isMuted && (
                <span className="shrink-0 text-text-tertiary" title="Muted">
                  <VolumeX size={12} />
                </span>
              )}
              {thread.isPinned && (
                <span className="shrink-0 text-text-secondary" title="Pinned">
                  <Pin size={12} className="fill-current" />
                </span>
              )}
              {thread.hasAttachments && (
                <span className="shrink-0 text-text-tertiary" title="Has attachments">
                  <Paperclip size={12} />
                </span>
              )}
              {thread.isStarred && (
                <span className="shrink-0 text-text-primary star-animate" title="Starred">
                  <Star size={12} className="fill-current" />
                </span>
              )}
              {thread.messageCount > 1 && (
                <span className="font-mono text-[10px] leading-4 tabular-nums text-text-secondary shrink-0 border border-border-primary rounded-full px-1.5">
                  {thread.messageCount}
                </span>
              )}
            </div>
          </div>
        </div>

      </button>
      {showSnooze && (
        <SnoozeDialog onSnooze={handleSnooze} onClose={() => setShowSnooze(false)} />
      )}
    </div>
  );
});
