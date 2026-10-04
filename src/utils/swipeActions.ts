import type { Thread } from "@/stores/threadStore";

export type SwipeAction = "none" | "trash" | "archive" | "toggleRead" | "star" | "snooze" | "spam";

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

export const DEFAULT_SWIPE_LEFT: SwipeAction = "trash";
export const DEFAULT_SWIPE_RIGHT: SwipeAction = "toggleRead";

export function isSwipeAction(value: unknown): value is SwipeAction {
  return typeof value === "string" && (SWIPE_ACTIONS as readonly string[]).includes(value);
}

/** Views in which a swipe must not run: drafts have no mail-list actions, and trash deletes for good. */
export function resolveSwipeAction(action: SwipeAction, activeLabel: string): SwipeAction {
  if (activeLabel === "drafts") return "none";
  if (action === "trash" && activeLabel === "trash") return "none";
  return action;
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
