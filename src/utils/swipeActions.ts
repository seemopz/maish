import type { Thread } from "@/stores/threadStore";

export type SwipeAction = "none" | "trash" | "archive" | "toggleRead" | "star" | "snooze" | "spam";

/** An action that can be a button; "none" only means "nothing to run". */
export type SwipeButtonAction = Exclude<SwipeAction, "none">;

export const SWIPE_ACTIONS: readonly SwipeAction[] = [
  "trash",
  "archive",
  "toggleRead",
  "star",
  "snooze",
  "spam",
  "none",
];

export const SWIPE_ACTION_LABELS: Record<SwipeAction, string> = {
  none: "Off",
  trash: "Delete",
  archive: "Archive",
  toggleRead: "Mark read / unread",
  star: "Star / unstar",
  snooze: "Snooze",
  spam: "Mark as spam",
};

/** At most this many buttons per side; the first one is also what a full swipe runs. */
export const MAX_SWIPE_ACTIONS = 3;

export const DEFAULT_SWIPE_LEFT: readonly SwipeButtonAction[] = ["trash", "archive"];
export const DEFAULT_SWIPE_RIGHT: readonly SwipeButtonAction[] = ["toggleRead", "snooze"];

export function isSwipeAction(value: unknown): value is SwipeAction {
  return typeof value === "string" && (SWIPE_ACTIONS as readonly string[]).includes(value);
}

/** Keeps the real actions of a list, once each, in order, up to `MAX_SWIPE_ACTIONS`. */
export function normalizeSwipeActions(value: unknown): SwipeButtonAction[] {
  if (!Array.isArray(value)) return [];
  const out: SwipeButtonAction[] = [];
  for (const v of value) {
    if (isSwipeAction(v) && v !== "none" && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_SWIPE_ACTIONS);
}

/**
 * Reads the saved lists of one side. `raw` is the JSON list; `legacy` is the single
 * action older versions saved ("none" meant off, so it becomes an empty list).
 * Returns `null` when neither was ever saved, so the caller keeps its default.
 */
export function parseSwipeActions(raw: string | null, legacy: string | null): SwipeButtonAction[] | null {
  if (raw !== null) {
    try {
      return normalizeSwipeActions(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return isSwipeAction(legacy) ? normalizeSwipeActions([legacy]) : null;
}

/** Views in which a swipe must not run: drafts have no mail-list actions, and trash deletes for good. */
export function resolveSwipeAction(action: SwipeAction, activeLabel: string): SwipeAction {
  if (activeLabel === "drafts") return "none";
  if (action === "trash" && activeLabel === "trash") return "none";
  return action;
}

/** The buttons of one side in this view; actions that must not run here are dropped. */
export function resolveSwipeActions(actions: readonly SwipeButtonAction[], activeLabel: string): SwipeButtonAction[] {
  return actions.filter((a) => resolveSwipeAction(a, activeLabel) !== "none");
}

/** What the coloured field under the card says; depends on the thread's current state. */
export function describeSwipeAction(action: SwipeAction, thread: Thread): string {
  switch (action) {
    case "toggleRead":
      return thread.isRead ? "Mark unread" : "Mark read";
    case "star":
      return thread.isStarred ? "Unstar" : "Star";
    case "spam":
      return thread.labelIds.includes("SPAM") ? "Not spam" : "Spam";
    default:
      return SWIPE_ACTION_LABELS[action];
  }
}

/**
 * The list after the select of slot `i` (0 = the full-swipe default) was set to
 * `value`. Emptying a slot drops it and the ones after it, so Off in the first slot
 * switches the side off.
 */
export function setSwipeSlot(actions: readonly SwipeButtonAction[], i: number, value: string): SwipeButtonAction[] {
  if (!isSwipeAction(value) || value === "none") return actions.slice(0, i);
  const next = [...actions];
  next[i] = value;
  return normalizeSwipeActions(next.slice(0, Math.max(i + 1, actions.length)));
}

/** Where one button sits in the field under a swiped card, measured from the card's far edge. */
export interface SwipeButtonBox {
  /** Distance from the outer edge of the field (px, or "100%" to sit entirely outside it). */
  edge: number | "100%";
  /** Width (px, or "100%" to fill the field). */
  size: number | "100%";
}

/**
 * Layout of button `i` of `count` in a field `fieldPx` wide. Up to the width of all
 * buttons they sit side by side; pulling further stretches the first one, which
 * pushes the others out along the card's edge; at the full swipe the first fills
 * the field and the others leave it. `"100%"` (not a px value) lets the field's own
 * width carry them from there, so only the flip needs a transition.
 */
export function swipeButtonBox(i: number, count: number, fieldPx: number, armed: boolean, buttonPx: number): SwipeButtonBox {
  const first = buttonPx + Math.max(0, fieldPx - count * buttonPx);
  if (i === 0) return { edge: 0, size: armed ? "100%" : first };
  return { edge: armed ? "100%" : first + (i - 1) * buttonPx, size: buttonPx };
}
