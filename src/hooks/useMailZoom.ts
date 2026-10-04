import { useEffect, type RefObject } from "react";
import { useUIStore } from "@/stores/uiStore";
import { MAIL_ZOOM_DEFAULT, MAIL_ZOOM_STEP } from "@/utils/mailZoom";

/** Wheel events in line mode (deltaMode 1) count this many px per line. */
const LINE_PX = 16;
/** Zoom change per wheel px: a pinch sends many small deltas, a mouse wheel few large ones. */
const WHEEL_ZOOM_PER_PX = 0.01;
/** One mouse-wheel notch must not jump more than this (px of delta). */
const WHEEL_MAX_PX = 25;

/**
 * Zoom of the mail body: pinch on a trackpad (it arrives as ctrl+wheel) or
 * Ctrl + wheel over `ref`, and Ctrl/Cmd with `+`, `-` or `0` anywhere. The
 * level lives in the UI store; `EmailRenderer` applies it inside the frame.
 */
export function useMailZoom(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      // Without this the webview zooms the whole page on top of the mail body.
      e.preventDefault();
      const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : 1);
      const clamped = Math.max(-WHEEL_MAX_PX, Math.min(WHEEL_MAX_PX, px));
      const { mailZoom, setMailZoom } = useUIStore.getState();
      setMailZoom(mailZoom * Math.exp(-clamped * WHEEL_ZOOM_PER_PX));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const { mailZoom, setMailZoom } = useUIStore.getState();
      if (e.key === "+" || e.key === "=") setMailZoom(mailZoom + MAIL_ZOOM_STEP);
      else if (e.key === "-" || e.key === "_") setMailZoom(mailZoom - MAIL_ZOOM_STEP);
      else if (e.key === "0") setMailZoom(MAIL_ZOOM_DEFAULT);
      else return;
      e.preventDefault();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, enabled]);
}
