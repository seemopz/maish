import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { formatRelativeDate } from "@/utils/date";
import { Paperclip, Star, Check, Pin, BellRing, VolumeX, Archive, Trash2, MailOpen, Clock, Ban } from "lucide-react";
import { useSwipeGesture, isSwipeTail, type SwipeDirection } from "@/hooks/useSwipeGesture";
import { resolveSwipeActions, describeSwipeAction, swipeButtonBox, type SwipeButtonAction } from "@/utils/swipeActions";
import { runSwipeAction } from "@/services/swipeActions";
import { logToFile } from "@/services/logFile";
import { snoozeThread } from "@/services/snooze/snoozeManager";
import { SnoozeDialog } from "./SnoozeDialog";
import type { ReactNode } from "react";
import type { DragData } from "@/components/dnd/DndProvider";

const BADGE_CATEGORIES = new Set(["Updates", "Promotions", "Social", "Newsletters"]);

const SWIPE_VISUALS: Record<SwipeButtonAction, { bg: string; icon: ReactNode }> = {
  trash: { bg: "bg-danger", icon: <Trash2 size={16} /> },
  spam: { bg: "bg-danger", icon: <Ban size={16} /> },
  archive: { bg: "bg-success", icon: <Archive size={16} /> },
  snooze: { bg: "bg-warning", icon: <Clock size={16} /> },
  star: { bg: "bg-warning", icon: <Star size={16} /> },
  toggleRead: { bg: "bg-accent", icon: <MailOpen size={16} /> },
};

/** Width of one swipe button, px. */
const SWIPE_BUTTON_PX = 64;
/** The first button fills the field, and the others leave it, over this long after the full swipe is reached. */
const SWIPE_STRETCH_MS = 280;
const SWIPE_STRETCH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

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
  const swipeLeftActions = useUIStore((s) => s.swipeLeftActions);
  const swipeRightActions = useUIStore((s) => s.swipeRightActions);
  const leftButtons = useMemo(() => resolveSwipeActions(swipeLeftActions, activeLabel), [swipeLeftActions, activeLabel]);
  const rightButtons = useMemo(() => resolveSwipeActions(swipeRightActions, activeLabel), [swipeRightActions, activeLabel]);
  const openSide = useUIStore((s) => (s.openSwipe?.threadId === thread.id ? s.openSwipe.side : null));
  const setOpenSwipe = useUIStore((s) => s.setOpenSwipe);
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

  const runButton = (action: SwipeButtonAction) => {
    setOpenSwipe(null);
    if (action === "snooze") setShowSnooze(true);
    else {
      runSwipeAction(action, thread).catch((err) =>
        logToFile("error", `Swipe action ${action} failed: ${String(err)}`),
      );
    }
  };

  // Two-finger trackpad swipe or one-finger touch swipe; a single thread only, never over a multi-selection or a drag.
  // A light swipe opens the side's buttons, a full swipe runs the first one.
  const { offset, armed } = useSwipeGesture(swipeRef, {
    enabled: !hasMultiSelect && !isDragging,
    allowLeft: leftButtons.length > 0,
    allowRight: rightButtons.length > 0,
    revealLeftPx: leftButtons.length * SWIPE_BUTTON_PX,
    revealRightPx: rightButtons.length * SWIPE_BUTTON_PX,
    revealed: openSide,
    onReveal: (side) => setOpenSwipe(side ? { threadId: thread.id, side } : null),
    onCommit: (direction: SwipeDirection) => {
      const action = (direction === "left" ? leftButtons : rightButtons)[0];
      if (action) runButton(action);
    },
  });
  // The hook runs the card to rest on a spring, so `offset` is non-zero until it arrives
  // and the field under the card stays mounted for the whole settle.
  const moving = offset !== 0;
  const side: SwipeDirection | null = offset < 0 ? "left" : offset > 0 ? "right" : null;
  const buttons = side === "left" ? leftButtons : rightButtons;
  const first = buttons[0];
  // Crossing the full swipe (either way) animates the stretch; between the crossings the
  // widths follow the card frame by frame, so a transition would only make them lag.
  // Counted, so a second crossing inside the ease restarts it. Derived during render so the
  // first frame of the new layout already carries the transition.
  const [prevArmed, setPrevArmed] = useState(armed);
  const [stretching, setStretching] = useState(0);
  if (armed !== prevArmed) {
    setPrevArmed(armed);
    setStretching((n) => n + 1);
  }
  useEffect(() => {
    if (stretching === 0) return;
    const id = setTimeout(() => setStretching(0), SWIPE_STRETCH_MS);
    return () => clearTimeout(id);
  }, [stretching]);
  const stretchTransition = stretching > 0 ? `${SWIPE_STRETCH_MS}ms ${SWIPE_STRETCH_EASE}` : undefined;

  // An open card closes on a click elsewhere, on scrolling the list and on Escape.
  const close = useCallback(() => setOpenSwipe(null), [setOpenSwipe]);
  useEffect(() => {
    if (!openSide) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!swipeRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    // The tail of the swipe that opened the card may still nudge the list.
    const onScroll = () => {
      if (!isSwipeTail()) close();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [openSide, close]);

  const handleSnooze = async (until: number) => {
    setShowSnooze(false);
    try {
      await snoozeThread(thread.accountId, thread.id, until);
      removeThread(thread.id);
    } catch (err) {
      logToFile("error", `Swipe snooze failed: ${String(err)}`);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (openSide) {
      // Like Apple Mail: a tap on the open card closes it instead of opening the thread.
      close();
    } else if (e.shiftKey) {
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
    <div ref={swipeRef} style={{ touchAction: "pan-y" }} className="relative overflow-hidden">
      {moving && side && first && (
        <div
          data-testid="swipe-field"
          // Fades in over the first px: the tail of the spring leaves a field a fraction of a px
          // wide, which would show as a coloured hairline at the card's edge before it vanishes.
          style={{ width: Math.abs(offset), opacity: Math.min(1, Math.abs(offset) / 16) }}
          className={`absolute inset-y-0 overflow-hidden ${SWIPE_VISUALS[first].bg} ${
            side === "right" ? "left-0" : "right-0"
          }`}
        >
          {buttons.map((action, i) => {
            const visual = SWIPE_VISUALS[action];
            const box = swipeButtonBox(i, buttons.length, Math.abs(offset), armed, SWIPE_BUTTON_PX);
            // Buttons hang from the outer edge of the field, which is the far side of the card.
            const edge = side === "right" ? "left" : "right";
            return (
              <button
                key={action}
                type="button"
                tabIndex={-1}
                onClick={() => runButton(action)}
                style={{
                  [edge]: box.edge,
                  width: box.size,
                  transition: stretchTransition && `width ${stretchTransition}, ${edge} ${stretchTransition}`,
                }}
                className={`absolute inset-y-0 flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-on-accent overflow-hidden ${visual.bg}`}
              >
                {visual.icon}
                <span className="whitespace-nowrap">{describeSwipeAction(action, thread)}</span>
              </button>
            );
          })}
        </div>
      )}
      <button
        ref={setNodeRef}
        style={
          moving
            ? {
                transform: `translateX(${offset}px)`,
                backgroundColor: "var(--color-bg-primary)",
              }
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
