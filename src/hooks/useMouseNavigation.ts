import { useEffect } from "react";
import { router } from "@/router";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";
import { useThreadStore } from "@/stores/threadStore";

/**
 * The side buttons of a mouse (3 = back, 4 = forward). With a mail open they
 * step to the previous or next mail in list order, like a swipe to the right or
 * left and like `k` and `j`; anywhere else they walk the router history.
 * Like `j`/`k` they stay put while a field has focus, so an unsent reply is not lost.
 */
export function useMouseNavigation() {
  useEffect(() => {
    // Some webviews navigate their own history on the press; the app does it on the release.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      const back = e.button === 3;

      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

      const threads = useThreadStore.getState().threads;
      const index = threads.findIndex((t) => t.id === getSelectedThreadId());
      if (index < 0) {
        if (back) router.history.back();
        else router.history.forward();
        return;
      }
      const target = threads[index + (back ? -1 : 1)];
      if (target) navigateToThread(target.id);
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}
