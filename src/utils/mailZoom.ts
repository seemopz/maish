export const MAIL_ZOOM_MIN = 0.5;
export const MAIL_ZOOM_MAX = 3;
export const MAIL_ZOOM_DEFAULT = 1;
/** One Ctrl+Plus / Ctrl+Minus step. */
export const MAIL_ZOOM_STEP = 0.1;

/** Keeps a zoom factor inside the allowed range. */
export function clampMailZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MAIL_ZOOM_DEFAULT;
  return Math.min(MAIL_ZOOM_MAX, Math.max(MAIL_ZOOM_MIN, zoom));
}

/**
 * Whole percent, for saving and for key steps. The live level is not rounded: a
 * slow pinch sends fractions of a pixel, and rounding each step would swallow it.
 */
export function roundMailZoom(zoom: number): number {
  return Math.round(zoom * 100) / 100;
}

/** Reads a saved zoom factor; anything unusable gives null. */
export function parseMailZoom(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const zoom = Number.parseFloat(value);
  return Number.isFinite(zoom) ? roundMailZoom(clampMailZoom(zoom)) : null;
}

export type MailZoomKey = "in" | "out" | "reset";

/**
 * The zoom a key press asks for: Ctrl/Cmd with `+`, `-` or `0`. These
 * combinations are reserved — they cannot be bound to another shortcut.
 */
export function mailZoomKey(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
): MailZoomKey | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}
