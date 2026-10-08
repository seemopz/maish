/**
 * Release physics for the swipe gesture: the fingers' speed decides open or close,
 * the card settles on a spring that starts at that speed, and a pull against a wall
 * gives like rubber. The formulas are the common ones: the rubber band and
 * deceleration rate of iOS scroll views, and a critically damped spring.
 * Pure functions; `useSwipeGesture` owns the state.
 */

/** A swipe faster than this (px/s) decides the release by its direction alone. */
export const FLICK_PX_S = 120;
/** Speed is capped, so a burst of wheel events cannot throw the card across the row. */
const V_MAX = 1600;
/** Share of the speed left per ms after a release; sets how far the card would coast. */
const DECEL = 0.998;
/** Only samples this recent (ms) count towards the speed; an older pause means rest. */
const VELOCITY_WINDOW_MS = 150;
/** Fewer ms than this between the first and last sample is too little to read a speed from. */
const MIN_SPAN_MS = 16;
/** Duration (ms) of the settle spring; critically damped, so it never overshoots. */
export const SPRING_MS = 300;
/** Pulling against a wall moves the card this much of the way (0..1) at the start. */
const RESISTANCE = 0.55;

/** `[time ms, signed offset px]` of one step of the card. */
export type Sample = [number, number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rubber-band offset for a pull of `distance` px (>= 0) on a row `dim` px wide: it flattens out. */
export function rubber(distance: number, dim: number, c = RESISTANCE): number {
  return (distance * dim * c) / (dim + c * distance);
}

/** Signed speed in px/s over the recent samples; 0 when there is no recent movement to read. */
export function velocityOf(samples: Sample[], now: number): number {
  const recent = samples.filter(([t]) => now - t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (recent.length < 2 || !first || !last) return 0;
  const span = last[0] - first[0];
  if (span < MIN_SPAN_MS) return 0;
  return clamp(((last[1] - first[1]) / span) * 1000, -V_MAX, V_MAX);
}

/** Distance (px) the card would coast from speed `v` (px/s). */
export const project = (v: number): number => ((v / 1000) * DECEL) / (1 - DECEL);

/** Position at `t` seconds of a critically damped spring from `from` to `to`, starting at speed `v0` (px/s). */
export function springAt(t: number, from: number, to: number, v0: number): number {
  const omega = (2 * Math.PI) / (SPRING_MS / 1000);
  const a = from - to;
  const b = v0 + omega * a;
  return to + (a + b * t) * Math.exp(-omega * t);
}

/**
 * Runs the spring on animation frames, calling `onFrame` with each position and
 * `onDone` after the last one (which is exactly `to`). Returns a function that stops it.
 * A spring that would cross `to` stops there: the card never swings past its rest.
 */
export function animateSpring(
  from: number,
  to: number,
  v0: number,
  onFrame: (position: number) => void,
  onDone: () => void,
): () => void {
  const start = performance.now();
  const side = Math.sign(from - to);
  let id = 0;
  const step = () => {
    const t = (performance.now() - start) / 1000;
    const position = springAt(t, from, to, v0);
    const crossed = side !== 0 && Math.sign(position - to) === -side;
    if (t * 1000 >= SPRING_MS * 1.5 || crossed || Math.abs(position - to) < 0.5) {
      onFrame(to);
      onDone();
      return;
    }
    onFrame(position);
    id = requestAnimationFrame(step);
  };
  id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(id);
}
