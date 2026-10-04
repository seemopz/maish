import { useCallback, useRef } from "react";
import { ThreadView } from "../email/ThreadView";
import { useThreadStore } from "@/stores/threadStore";
import { useSelectedThreadId } from "@/hooks/useRouteNavigation";
import { navigateToThread } from "@/router/navigate";
import { useSwipeGesture, type SwipeDirection } from "@/hooks/useSwipeGesture";
import { EmptyState } from "../ui/EmptyState";
import { ReadingPaneIllustration } from "../ui/illustrations";

export function ReadingPane() {
  const selectedThreadId = useSelectedThreadId();
  const selectedThread = useThreadStore((s) => selectedThreadId ? s.threadMap.get(selectedThreadId) ?? null : null);

  // The neighbours in list order, the same ones `j` and `k` step to.
  const nextId = useThreadStore((s) => {
    const i = s.threads.findIndex((t) => t.id === selectedThreadId);
    return i < 0 ? null : s.threads[i + 1]?.id ?? null;
  });
  const prevId = useThreadStore((s) => {
    const i = s.threads.findIndex((t) => t.id === selectedThreadId);
    return i < 1 ? null : s.threads[i - 1]?.id ?? null;
  });

  // Swiping left turns to the next mail, right to the previous one. Like j/k it
  // stays put while a field has focus: leaving would drop an unsent inline reply.
  const paneRef = useRef<HTMLDivElement>(null);
  const onCommit = useCallback((direction: SwipeDirection) => {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
    const id = direction === "left" ? nextId : prevId;
    if (id) navigateToThread(id);
  }, [nextId, prevId]);
  const { offset } = useSwipeGesture(paneRef, {
    enabled: selectedThread !== null,
    allowLeft: nextId !== null,
    allowRight: prevId !== null,
    onCommit,
  });

  if (!selectedThread) {
    return (
      <div className="flex-1 flex flex-col bg-bg-primary">
        <EmptyState illustration={ReadingPaneIllustration} title="Maish" subtitle="Select an email to read" />
      </div>
    );
  }

  return (
    <div ref={paneRef} className="flex-1 bg-bg-primary overflow-hidden">
      <div className="h-full" style={offset ? { transform: `translateX(${offset / 4}px)` } : undefined}>
        <ThreadView thread={selectedThread} />
      </div>
    </div>
  );
}
