export const MAIL_ZOOM_MIN = 0.5;
export const MAIL_ZOOM_MAX = 3;
export const MAIL_ZOOM_DEFAULT = 1;
/** One Ctrl+Plus / Ctrl+Minus step. */
export const MAIL_ZOOM_STEP = 0.1;

/** Keeps a zoom factor inside the allowed range, rounded to whole percent. */
export function clampMailZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MAIL_ZOOM_DEFAULT;
  return Math.round(Math.min(MAIL_ZOOM_MAX, Math.max(MAIL_ZOOM_MIN, zoom)) * 100) / 100;
}

/** Reads a saved zoom factor; anything unusable gives null. */
export function parseMailZoom(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const zoom = Number.parseFloat(value);
  return Number.isFinite(zoom) ? clampMailZoom(zoom) : null;
}
