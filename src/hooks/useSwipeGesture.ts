import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FLICK_PX_S, animateSpring, project, rubber, velocityOf, type Sample } from "@/utils/swipePhysics";

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
/** ...and always this far past the open buttons, so a light swipe cannot reach it by accident... */
const FULL_SWIPE_BEYOND_REVEAL_PX = 48;
/** ...twice as far when the swipe starts on an open card, which already sits at the buttons. */
const FULL_SWIPE_BEYOND_REVEAL_OPEN_PX = 96;
/**
 * A trackpad sends no "fingers lifted" event; this much silence ends the gesture.
 * Resting fingers send nothing either, so it is long enough to hold a pause
 * without the card settling under the fingers (momentum ends a swipe sooner).
 */
export const SWIPE_IDLE_MS = 400;
/** The momentum tail of a finished swipe counts as over after this much silence. */
const TAIL_QUIET_MS = 150;
/** Horizontal travel (px) before a swipe owns the wheel; until then vertical motion can cancel it. */
const LOCK_PX = 12;
/** A flick opens the buttons from this far out, so a twitch of the fingers does not. */
const FLICK_MIN_PX = 24;
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
  /** True while the card runs to rest on its spring after a release or a close. */
  settling: boolean;
}

const IDLE_STATE: SwipeState = { offset: 0, armed: false, active: false, settling: false };

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Distance at which a release commits. With open buttons it lies beyond them. */
export function commitThreshold(width: number, revealPx = 0, startedOpen = false): number {
  if (revealPx <= 0) return Math.min(SWIPE_THRESHOLD * width, SWIPE_MAX_PX);
  const full = Math.max(
    Math.min(FULL_SWIPE_FRACTION * width, FULL_SWIPE_MAX_PX),
    revealPx + (startedOpen ? FULL_SWIPE_BEYOND_REVEAL_OPEN_PX : FULL_SWIPE_BEYOND_REVEAL_PX),
  );
  return Math.min(full, 0.9 * width);
}

/**
 * Wheel events are ignored, on every element, until they have been quiet for
 * `TAIL_QUIET_MS`. It is set when a gesture ends on momentum or starts vertical.
 * Per hook it would not hold: a committed card is removed, the next one slides
 * under the pointer, and its fresh hook would read the momentum tail as a new swipe.
 */
let tailIgnored = false;
/** The tail belongs to a horizontal swipe (it ended on momentum), not to a vertical scroll. */
let tailHorizontal = false;
let tailTimer: ReturnType<typeof setTimeout> | undefined;

function ignoreTail(horizontal = false) {
  tailIgnored = true;
  if (horizontal) tailHorizontal = true;
  clearTimeout(tailTimer);
  tailTimer = setTimeout(() => {
    tailIgnored = false;
    tailHorizontal = false;
  }, TAIL_QUIET_MS);
}

/**
 * True while the momentum of a horizontal swipe plays out. Its `deltaY` can still
 * scroll the list, which must not count as the user scrolling away from a card the
 * swipe has just opened.
 */
export const isSwipeTail = () => tailHorizontal;

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
  /** The running settle spring and the offset it has reached; null when there is none. */
  const spring = useRef<{ stop: () => void; offset: number } | null>(null);
  const stopSpring = useCallback(() => {
    spring.current?.stop();
    spring.current = null;
  }, []);
  /** Runs the card from `from` to rest at `to` on a spring that starts at speed `v` (px/s). */
  const settle = useCallback(
    (from: number, to: number, v: number) => {
      stopSpring();
      if (Math.abs(from - to) < 0.5 || prefersReducedMotion()) {
        setState(IDLE_STATE);
        return;
      }
      const frame = (offset: number) => {
        if (spring.current) spring.current.offset = offset;
        setState({ offset, armed: false, active: false, settling: true });
      };
      frame(from);
      const stop = animateSpring(from, to, v, frame, () => {
        spring.current = null;
        setState(IDLE_STATE);
      });
      spring.current = { stop, offset: from };
    },
    [stopSpring],
  );
  const options = useRef({ allowLeft, allowRight, onCommit, revealLeftPx, revealRightPx, revealed, onReveal });
  useEffect(() => {
    options.current = { allowLeft, allowRight, onCommit, revealLeftPx, revealRightPx, revealed, onReveal };
  });

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    let mode: "idle" | "swiping" = "idle";
    let offset = 0;
    /** Where the fingers have taken the card, before the rubber band; `offset` is what is shown. */
    let raw = 0;
    let samples: Sample[] = [];
    /** The side (-1 left, 1 right) this gesture is on; 0 until it has left rest. A gesture never crosses rest. */
    let lockSide = 0;
    let width = 0;
    let locked = false;
    /** The gesture began on a card whose buttons were open. */
    let startedOpen = false;
    let peak = 0;
    let lastAbs = 0;
    let shrinking = 0;
    let lastWheelAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const revealPxFor = (signed: number) =>
      signed < 0 ? options.current.revealLeftPx : options.current.revealRightPx;
    /** Where the card rests: out by the width of the open buttons, or at 0. */
    const restOffset = () => {
      const { revealed, revealLeftPx, revealRightPx } = options.current;
      return revealed === "left" ? -revealLeftPx : revealed === "right" ? revealRightPx : 0;
    };
    /** A pull towards a side with no buttons gives like rubber instead of following the fingers. */
    const display = (r: number) => {
      const { allowLeft, allowRight } = options.current;
      if (r < 0 && !allowLeft) return -rubber(-r, width);
      if (r > 0 && !allowRight) return rubber(r, width);
      return r;
    };
    /** `r` limited to the card's width and to the side the gesture is on: pulling back stops at rest. */
    const hold = (r: number) => {
      const clamped = Math.max(-width, Math.min(width, r));
      // The side is only fixed once the card has really left rest: a first event that
      // twitches the wrong way must not lock the whole gesture to that side.
      if (lockSide === 0 && Math.abs(clamped) >= LOCK_PX) lockSide = Math.sign(clamped);
      if (lockSide === 0) return clamped;
      return lockSide < 0 ? Math.min(clamped, 0) : Math.max(clamped, 0);
    };
    /** Takes over from a spring still running, at the point it has reached. */
    const grab = () => {
      const from = spring.current?.offset ?? restOffset();
      stopSpring();
      raw = offset = from;
      lockSide = Math.abs(from) >= LOCK_PX ? Math.sign(from) : 0;
      samples = [];
      startedOpen = restOffset() !== 0;
      locked = offset !== 0;
    };
    const show = () => {
      samples.push([performance.now(), offset]);
      if (samples.length > 6) samples.shift();
      setState({
        offset,
        armed: Math.abs(offset) >= commitThreshold(width, revealPxFor(offset), startedOpen),
        active: true,
        settling: false,
      });
    };
    /**
     * Ends a gesture at `offset`: runs the action, or opens or closes the buttons,
     * and lets the card run to rest on a spring that starts at the fingers' speed.
     * A fast swipe decides by its direction, a slow one by where it would come to rest.
     */
    const finish = () => {
      const { allowLeft, allowRight } = options.current;
      const direction: SwipeDirection = offset < 0 ? "left" : "right";
      const revealPx = revealPxFor(offset);
      const abs = Math.abs(offset);
      // A pull towards a side with no buttons only gives; it never triggers.
      const blocked = direction === "left" ? !allowLeft : !allowRight;
      const hit = !blocked && abs >= commitThreshold(width, revealPx, startedOpen);
      const v = velocityOf(samples, performance.now());
      const out = direction === "left" ? -v : v; // speed away from the centre
      let open = false;
      if (!blocked && !hit && revealPx > 0 && abs >= 1) {
        open = Math.abs(out) >= FLICK_PX_S ? out > 0 && abs >= FLICK_MIN_PX : abs + project(out) >= SWIPE_REVEAL_MIN_PX;
      }
      const wasOpen = startedOpen;
      const from = offset;
      reset();
      if (hit) {
        options.current.onCommit(direction);
        return;
      }
      // A swipe back past the rest position of an open card has to close it, whatever
      // the other side is.
      if ((!blocked && revealPx > 0) || wasOpen) options.current.onReveal?.(open ? direction : null);
      settle(from, open ? (direction === "left" ? -revealPx : revealPx) : 0, v);
    };

    const reset = () => {
      offset = 0;
      raw = 0;
      lockSide = 0;
      samples = [];
      locked = false;
      startedOpen = false;
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
      const scale = e.deltaMode === 1 ? LINE_PX : 1;
      // Fingers moving left make deltaX positive; the card follows the fingers.
      const dx = -e.deltaX * scale;
      const dy = e.deltaY * scale;

      // After a pause, a vertical event is a new gesture (a scroll), not resting
      // fingers moving on: settle the swipe and let the scroll through.
      const paused = e.timeStamp - lastWheelAt > TAIL_QUIET_MS;
      lastWheelAt = e.timeStamp;
      if (mode === "swiping" && paused && Math.abs(dy) > Math.abs(dx)) {
        release();
        mode = "idle";
      }

      clearTimeout(timer);
      timer = setTimeout(() => {
        release();
        mode = "idle";
      }, SWIPE_IDLE_MS);

      if (mode === "idle") {
        if (dx === 0 && dy === 0) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          ignoreTail();
          return;
        }
        mode = "swiping";
        width = el.offsetWidth;
        grab();
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
        ignoreTail(true);
        return;
      }

      raw = hold(raw + dx);
      offset = display(raw);
      if (Math.abs(offset) >= LOCK_PX) locked = true;
      show();
    };

    // One finger. A pointer that is not `touch` is ignored.
    let touchMode: "idle" | "pending" | "swiping" | "ignored" = "idle";
    let touchId = -1;
    let startX = 0;
    let startY = 0;
    /** Where the card was when the finger took over; the finger's travel adds to it. */
    let touchBase = 0;

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
        grab();
        touchBase = raw;
      }
      raw = hold(touchBase + dx);
      offset = display(raw);
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
      if (touchMode === "swiping") {
        const from = offset;
        reset();
        settle(from, restOffset(), 0);
      }
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
      stopSpring();
      setState(IDLE_STATE);
    };
  }, [ref, enabled, settle, stopSpring]);

  const rest = revealed === "left" ? -revealLeftPx : revealed === "right" ? revealRightPx : 0;
  // A close that comes from outside (tap elsewhere, Escape, another card opening) has
  // no release to start the spring: run it here, from where the card was resting.
  const activeNow = useRef(false);
  activeNow.current = state.active;
  const lastRest = useRef(rest);
  useLayoutEffect(() => {
    const from = lastRest.current;
    lastRest.current = rest;
    if (from !== rest && !activeNow.current && !spring.current) settle(from, rest, 0);
  }, [rest, settle]);

  if (state.active || state.settling) return state;
  return rest === 0 ? state : { offset: rest, armed: false, active: false, settling: false };
}
