import { useUndoStore } from "@/stores/undoStore";
import { logToFile } from "@/services/logFile";

/** How long the toast stays and the server call is held back. */
export const UNDO_WINDOW_MS = 5000;
/** Fallback: calls of one kind closer together than this belong to one batch. */
const BATCH_GAP_MS = 1000;

export interface UndoableItem {
  /** Sends the action to the server now; the queued copy is the fallback. */
  commit: () => Promise<void>;
  /** Drops the queued copy and puts the local state back; nothing has reached the server. */
  revert: () => Promise<void>;
}

interface Batch {
  kind: string;
  items: UndoableItem[];
  lastAddedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

let current: Batch | null = null;
let openBatches = 0;

/**
 * Runs a multi-select action as one undo step, however long each thread takes.
 * Without it, calls that are more than BATCH_GAP_MS apart would split the batch.
 */
export async function undoBatch<T>(fn: () => Promise<T>): Promise<T> {
  openBatches++;
  try {
    return await fn();
  } finally {
    openBatches--;
  }
}

/**
 * Archive, trash, spam and move are applied locally at once and sent to the
 * server only after the undo window. IMAP gives no way back: a move assigns
 * new UIDs the client never learns, so an inverse move could not address the
 * messages. Holding the call back makes undo exact on every provider.
 *
 * The caller has already stored the call in the pending-operations queue with
 * a delayed retry time, so quitting or crashing inside the window loses
 * nothing: the queue processor sends it on the next start. `commit` sends it
 * early, `revert` takes it out of the queue and restores the local state.
 */
export function registerUndoable(
  kind: string,
  describe: (count: number) => string,
  item: UndoableItem,
): void {
  const now = Date.now();
  const sameBatch =
    current !== null &&
    current.kind === kind &&
    (openBatches > 0 || now - current.lastAddedAt <= BATCH_GAP_MS);
  if (current && !sameBatch) {
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
