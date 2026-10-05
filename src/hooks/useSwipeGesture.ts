import { useEffect, useRef, useState, type RefObject } from "react";

export type SwipeDirection = "left" | "right";

/** Share of the element's width a swipe has to cover to trigger on release. */
export const SWIPE_THRESHOLD = 0.25;
/** ...but never more than this many px, so a wide pane does not need a long swipe. */
export const SWIPE_MAX_PX = 120;
/** Two-stage swipe: a swipe past this many px, released short of the full swipe, opens the buttons. */
export const SWIPE_REVEAL_MIN_PX = 56;
/** Two-stage swipe: the full swipe, which runs the default action, is this share of the width... */
const FULL_SWIPE_FRACTION = 0.5;
/** ...at most this many px... */
const FULL_SWIPE_MAX_PX = 220;
/** ...and always this far past the open buttons, so a light swipe cannot reach it by accident. */
const FULL_SWIPE_BEYOND_REVEAL_PX = 48;
/** A trackpad sends no "fingers lifted" event; this much silence ends the gesture. */
export const SWIPE_IDLE_MS = 150;
/** Horizontal travel (px) before a swipe owns the wheel; until then vertical motion can cancel it. */
const LOCK_PX = 12;
/** Wheel events in line mode (deltaMode 1) count this many px per line. */
const LINE_PX = 16;
/**
 * This many strictly shrinking events in a row, the last at most a third of the
 * peak, mean the fingers are off and momentum is playing out. Easing off at the
 * end of a slow swipe is shorter and less smooth than that.
 */
const MOMENTUM_RUN = 6;
const MOMENTUM_FRACTION = 1 / 3;
/** A finger has to travel this far (px) before the direction is decided. */
const TOUCH_SLOP_PX = 10;
/** The click a finger swipe leaves behind is swallowed for this long (ms). */
const CLICK_SUPPRESS_MS = 400;

interface SwipeOptions {
  enabled: boolean;
  allowLeft: boolean;
  allowRight: boolean;
  onCommit: (direction: SwipeDirection) => void;
  /**
   * Two-stage swipe. Width in px of the buttons a light swipe opens on each side
   * (0 = that side has none and works as a plain one-stage swipe). With a width
   * set, a swipe released between `SWIPE_REVEAL_MIN_PX` and the full swipe calls
   * `onReveal` instead of `onCommit`, and only the full swipe commits.
   */
  revealLeftPx?: number;
  revealRightPx?: number;
  /** The side whose buttons are open. The card rests there and a swipe starts from there. */
  revealed?: SwipeDirection | null;
  /** Called on release with the side to open, or `null` to close. */
  onReveal?: (direction: SwipeDirection | null) => void;
}

export interface SwipeState {
  /** Signed distance in px the card follows the fingers; negative is left. */
  offset: number;
  /** True once releasing now would trigger. */
  armed: boolean;
  /** True while fingers are moving the card; false at rest, including when the buttons are open. */
  active: boolean;
}

const IDLE_STATE: SwipeState = { offset: 0, armed: false, active: false };

/** Distance at which a release commits. With open buttons it lies beyond them. */
export function commitThreshold(width: number, revealPx = 0): number {
  if (revealPx <= 0) return Math.min(SWIPE_THRESHOLD * width, SWIPE_MAX_PX);
  const full = Math.max(
    Math.min(FULL_SWIPE_FRACTION * width, FULL_SWIPE_MAX_PX),
    revealPx + FULL_SWIPE_BEYOND_REVEAL_PX,
  );
  return Math.min(full, 0.9 * width);
}

/**
 * Wheel events are ignored, on every element, until they have been quiet for
 * `SWIPE_IDLE_MS`. It is set when a gesture ends on momentum or starts vertical.
 * Per hook it would not hold: a committed card is removed, the next one slides
 * under the pointer, and its fresh hook would read the momentum tail as a new swipe.
 */
let tailIgnored = false;
let tailTimer: ReturnType<typeof setTimeout> | undefined;

function ignoreTail() {
  tailIgnored = true;
  clearTimeout(tailTimer);
  tailTimer = setTimeout(() => {
    tailIgnored = false;
  }, SWIPE_IDLE_MS);
}

/**
 * Horizontal swipe on an element, from two sources: a two-finger trackpad swipe
 * read from `wheel` events (`deltaX`), and a one-finger swipe read from touch
 * pointer events (the element needs `touch-action: pan-y` so the browser keeps
 * only the vertical pan). A gesture that starts vertical stays with the
 * browser's scrolling. A trackpad swipe ends when the events stop, or as soon as
 * the deltas decay like momentum; the tail of the momentum is then ignored, on
 * every element until it has been quiet, so it cannot start a second swipe. A finger swipe ends on lift-off, and the click
 * that would follow is swallowed. With `revealLeftPx`/`revealRightPx` the swipe has
 * two stages: a light one opens buttons (`onReveal`), only a full one commits. Mouse pointers never swipe (they drag).
 */
export function useSwipeGesture(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    allowLeft,
    allowRight,
    onCommit,
    revealLeftPx = 0,
    revealRightPx = 0,
    revealed = null,
    onReveal,
  }: SwipeOptions,
): SwipeState {
  const [state, setState] = useState<SwipeState>(IDLE_STATE);
  const options = useRef({ allowLeft, allowRight, onCommit, revealLeftPx, revealRightPx, revealed, onReveal });
  useEffect(() => {
    options.current = { allowLeft, allowRight, onCommit, revealLeftPx, revealRightPx, revealed, onReveal };
  });

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    let mode: "idle" | "swiping" = "idle";
    let offset = 0;
    let width = 0;
    let locked = false;
    let peak = 0;
    let lastAbs = 0;
    let shrinking = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const revealPxFor = (signed: number) =>
      signed < 0 ? options.current.revealLeftPx : options.current.revealRightPx;
    /** Where the card rests: out by the width of the open buttons, or at 0. */
    const restOffset = () => {
      const { revealed, revealLeftPx, revealRightPx } = options.current;
      return revealed === "left" ? -revealLeftPx : revealed === "right" ? revealRightPx : 0;
    };
    const show = () =>
      setState({
        offset,
        armed: Math.abs(offset) >= commitThreshold(width, revealPxFor(offset)),
        active: true,
      });
    /** Ends a gesture at `offset`: runs the action, opens or closes the buttons, or snaps back. */
    const finish = () => {
      const direction: SwipeDirection = offset < 0 ? "left" : "right";
      const revealPx = revealPxFor(offset);
      const abs = Math.abs(offset);
      const hit = abs >= commitThreshold(width, revealPx);
      const open = !hit && abs >= SWIPE_REVEAL_MIN_PX;
      reset();
      if (hit) options.current.onCommit(direction);
      else if (revealPx > 0) options.current.onReveal?.(open ? direction : null);
    };

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
      finish();
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom arrives as ctrl+wheel
      if (tailIgnored) {
        ignoreTail();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        release();
        mode = "idle";
      }, SWIPE_IDLE_MS);

      const scale = e.deltaMode === 1 ? LINE_PX : 1;
      // Fingers moving left make deltaX positive; the card follows the fingers.
      const dx = -e.deltaX * scale;
      const dy = e.deltaY * scale;

      if (mode === "idle") {
        if (dx === 0 && dy === 0) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          ignoreTail();
          return;
        }
        mode = "swiping";
        width = el.offsetWidth;
        offset = restOffset();
        locked = offset !== 0;
      } else if (!locked && Math.abs(dy) > Math.abs(dx)) {
        reset();
        mode = "idle";
        ignoreTail();
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
      if (shrinking >= MOMENTUM_RUN && abs <= peak * MOMENTUM_FRACTION) {
        release();
        mode = "idle";
        ignoreTail();
        return;
      }

      let next = offset + dx;
      if (next < 0 && !options.current.allowLeft) next = 0;
      if (next > 0 && !options.current.allowRight) next = 0;
      offset = Math.max(-width, Math.min(width, next));
      if (Math.abs(offset) >= LOCK_PX) locked = true;
      show();
    };

    // One finger. A pointer that is not `touch` is ignored.
    let touchMode: "idle" | "pending" | "swiping" | "ignored" = "idle";
    let touchId = -1;
    let startX = 0;
    let startY = 0;

    const swallowClick = () => {
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      el.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", stop, { capture: true }), CLICK_SUPPRESS_MS);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      touchMode = "pending";
      touchId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      width = el.offsetWidth;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== touchId || touchMode === "idle" || touchMode === "ignored") return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (touchMode === "pending") {
        if (Math.abs(dx) < TOUCH_SLOP_PX && Math.abs(dy) < TOUCH_SLOP_PX) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          touchMode = "ignored";
          return;
        }
        touchMode = "swiping";
      }
      let next = restOffset() + dx;
      if (next < 0 && !options.current.allowLeft) next = 0;
      if (next > 0 && !options.current.allowRight) next = 0;
      offset = Math.max(-width, Math.min(width, next));
      show();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== touchId) return;
      const swiped = touchMode === "swiping";
      touchMode = "idle";
      if (!swiped) return;
      swallowClick();
      finish();
    };

    // The browser took the gesture over (vertical scroll) or the system aborted it.
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== touchId) return;
      if (touchMode === "swiping") reset();
      touchMode = "idle";
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      clearTimeout(timer);
      setState(IDLE_STATE);
    };
  }, [ref, enabled]);

  if (state.active) return state;
  const rest = revealed === "left" ? -revealLeftPx : revealed === "right" ? revealRightPx : 0;
  return rest === 0 ? state : { offset: rest, armed: false, active: false };
}
