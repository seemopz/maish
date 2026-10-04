import { useUndoStore } from "@/stores/undoStore";
import { logToFile } from "@/services/logFile";

/** How long the toast stays and the server call is held back. */
export const UNDO_WINDOW_MS = 5000;
/** Calls of one kind closer together than this belong to one multi-select action. */
const BATCH_GAP_MS = 1000;

export interface UndoableItem {
  /** Sends the action to the server, or queues it while offline. */
  commit: () => Promise<void>;
  /** Puts the local state back; nothing has reached the server yet. */
  revert: () => Promise<void>;
}

interface Batch {
  kind: string;
  items: UndoableItem[];
  lastAddedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

let current: Batch | null = null;

/**
 * Archive, trash, spam and move are applied locally at once and sent to the
 * server only after the undo window. IMAP gives no way back: a move assigns
 * new UIDs the client never learns, so an inverse move could not address the
 * messages. Holding the call back makes undo exact on every provider and
 * leaves the offline queue untouched, because nothing is queued until commit.
 */
export function registerUndoable(
  kind: string,
  describe: (count: number) => string,
  item: UndoableItem,
): void {
  const now = Date.now();
  if (current && (current.kind !== kind || now - current.lastAddedAt > BATCH_GAP_MS)) {
    void flushPendingUndo();
  }
  if (current) clearTimeout(current.timer);
  const items = [...(current?.items ?? []), item];
  current = {
    kind,
    items,
    lastAddedAt: now,
    timer: setTimeout(() => void flushPendingUndo(), UNDO_WINDOW_MS),
  };
  useUndoStore.getState().show(describe(items.length));
}

/** Sends everything that is still waiting out its undo window. */
export async function flushPendingUndo(): Promise<void> {
  const batch = current;
  if (!batch) return;
  current = null;
  clearTimeout(batch.timer);
  useUndoStore.getState().hide();
  for (const item of batch.items) {
    try {
      await item.commit();
    } catch (err) {
      logToFile("error", `Deferred mail action failed: ${String(err)}`);
    }
  }
}

/** Takes back the whole current batch. Returns false when there was nothing to undo. */
export async function undoPending(): Promise<boolean> {
  const batch = current;
  if (!batch) return false;
  current = null;
  clearTimeout(batch.timer);
  useUndoStore.getState().hide();
  for (const item of [...batch.items].reverse()) {
    try {
      await item.revert();
    } catch (err) {
      logToFile("error", `Undo of mail action failed: ${String(err)}`);
    }
  }
  // The list reloads from the restored local state.
  window.dispatchEvent(new Event("maish-sync-done"));
  return true;
}

if (typeof window !== "undefined") {
  // Closing the window must not drop an action the user already saw succeed.
  window.addEventListener("pagehide", () => void flushPendingUndo());
}
