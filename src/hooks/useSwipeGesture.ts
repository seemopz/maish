import { useEffect, useRef, useState, type RefObject } from "react";

export type SwipeDirection = "left" | "right";

/** Share of the element's width a swipe has to cover to trigger on release. */
export const SWIPE_THRESHOLD = 0.4;
/** A trackpad sends no "fingers lifted" event; this much silence ends the gesture. */
export const SWIPE_IDLE_MS = 150;
/** Horizontal travel (px) before a swipe owns the wheel; until then vertical motion can cancel it. */
const LOCK_PX = 12;
/** Wheel events in line mode (deltaMode 1) count this many px per line. */
const LINE_PX = 16;
/** This many shrinking events in a row, each at most half the peak, mean the fingers are off and momentum is playing out. */
const MOMENTUM_RUN = 4;

interface SwipeOptions {
  enabled: boolean;
  allowLeft: boolean;
  allowRight: boolean;
  onCommit: (direction: SwipeDirection) => void;
}

export interface SwipeState {
  /** Signed distance in px the card follows the fingers; negative is left. */
  offset: number;
  /** True once releasing now would trigger. */
  armed: boolean;
}

const IDLE_STATE: SwipeState = { offset: 0, armed: false };

/**
 * Two-finger horizontal swipe on an element, read from `wheel` events
 * (a trackpad reports it as `deltaX`). A gesture that starts vertical stays
 * with the browser's scrolling. It ends when the events stop, or as soon as the
 * deltas decay like momentum; the tail of the momentum is then ignored so it
 * cannot start a second swipe.
 */
export function useSwipeGesture(
  ref: RefObject<HTMLElement | null>,
  { enabled, allowLeft, allowRight, onCommit }: SwipeOptions,
): SwipeState {
  const [state, setState] = useState<SwipeState>(IDLE_STATE);
  const options = useRef({ allowLeft, allowRight, onCommit });
  useEffect(() => {
    options.current = { allowLeft, allowRight, onCommit };
  });

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    let mode: "idle" | "swiping" | "ignored" = "idle";
    let offset = 0;
    let width = 0;
    let locked = false;
    let peak = 0;
    let lastAbs = 0;
    let shrinking = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      offset = 0;
      locked = false;
      peak = 0;
      lastAbs = 0;
      shrinking = 0;
      setState(IDLE_STATE);
    };

    const release = () => {
      if (mode !== "swiping") return;
      const direction: SwipeDirection = offset < 0 ? "left" : "right";
      const hit = Math.abs(offset) >= SWIPE_THRESHOLD * width;
      reset();
      if (hit) options.current.onCommit(direction);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom arrives as ctrl+wheel
      clearTimeout(timer);
      timer = setTimeout(() => {
        release();
        mode = "idle";
      }, SWIPE_IDLE_MS);

      if (mode === "ignored") return;
      const scale = e.deltaMode === 1 ? LINE_PX : 1;
      // Fingers moving left make deltaX positive; the card follows the fingers.
      const dx = -e.deltaX * scale;
      const dy = e.deltaY * scale;

      if (mode === "idle") {
        if (dx === 0 && dy === 0) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          mode = "ignored";
          return;
        }
        mode = "swiping";
        width = el.offsetWidth;
      } else if (!locked && Math.abs(dy) > Math.abs(dx)) {
        reset();
        mode = "ignored";
        return;
      }

      const abs = Math.abs(dx);
      if (abs > peak) {
        peak = abs;
        shrinking = 0;
      } else if (abs < lastAbs) {
        shrinking++;
      } else {
        shrinking = 0;
      }
      lastAbs = abs;
      e.preventDefault();
      if (shrinking >= MOMENTUM_RUN && abs <= peak / 2) {
        release();
        mode = "ignored";
        return;
      }

      let next = offset + dx;
      if (next < 0 && !options.current.allowLeft) next = 0;
      if (next > 0 && !options.current.allowRight) next = 0;
      offset = Math.max(-width, Math.min(width, next));
      if (Math.abs(offset) >= LOCK_PX) locked = true;
      setState({ offset, armed: Math.abs(offset) >= SWIPE_THRESHOLD * width });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
      setState(IDLE_STATE);
    };
  }, [ref, enabled]);

  return state;
}
