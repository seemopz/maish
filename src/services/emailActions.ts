import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import {
  enqueuePendingOperation,
  deleteOperation,
  holdOperation,
} from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { getDb } from "@/services/db/connection";
import { getMessageIdsForThread } from "@/services/db/messages";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";
import { registerUndoable, UNDO_WINDOW_MS } from "@/services/undoableActions";
import { logToFile } from "@/services/logFile";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "createDraft";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "updateDraft";
      draftId: string;
      rawBase64Url: string;
      threadId?: string;
    }
  | { type: "deleteDraft"; draftId: string };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Optimistic UI helpers
// ---------------------------------------------------------------------------

function getNextThreadId(currentId: string): string | null {
  // Only auto-advance if the removed thread is the one being viewed
  const selectedId = getSelectedThreadId();
  if (selectedId !== currentId) return null;
  const { threads } = useThreadStore.getState();
  const idx = threads.findIndex((t) => t.id === currentId);
  if (idx === -1) return null;
  // Prefer next thread, fall back to previous
  const next = threads[idx + 1];
  if (next) return next.id;
  const prev = threads[idx - 1];
  if (prev) return prev.id;
  return null;
}

function applyOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "archive":
    case "trash":
    case "permanentDelete":
    case "spam":
    case "moveToFolder": {
      const nextId = getNextThreadId(action.threadId);
      store.removeThread(action.threadId);
      if (nextId) {
        navigateToThread(nextId);
      }
      break;
    }
    case "markRead":
      store.updateThread(action.threadId, { isRead: action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: action.starred });
      break;
    case "addLabel":
    case "removeLabel":
    case "sendMessage":
    case "createDraft":
    case "updateDraft":
    case "deleteDraft":
      // No universal optimistic update for these
      break;
  }
}

function revertOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "markRead":
      store.updateThread(action.threadId, { isRead: !action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: !action.starred });
      break;
    // For removes (archive/trash/spam/move), we can't easily restore the thread
    // to the list from here. The next sync will fix it.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      await db.execute(
        "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
        [action.read ? 1 : 0, accountId, action.threadId],
      );
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
          [accountId, action.threadId],
        );
      }
      break;
    case "addLabel":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  if ("draftId" in action) return action.draftId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field — it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);
  switch (action.type) {
    case "archive":
      return provider.archive(action.threadId, action.messageIds);
    case "trash":
      return provider.trash(action.threadId, action.messageIds);
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(
        action.threadId,
        action.messageIds,
        action.read,
      );
    case "star":
      return provider.star(
        action.threadId,
        action.messageIds,
        action.starred,
      );
    case "spam":
      return provider.spam(
        action.threadId,
        action.messageIds,
        action.isSpam,
      );
    case "moveToFolder":
      return provider.moveToFolder(
        action.threadId,
        action.messageIds,
        action.folderPath,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage":
      return provider.sendMessage(action.rawBase64Url, action.threadId);
    case "createDraft":
      return provider.createDraft(action.rawBase64Url, action.threadId);
    case "updateDraft":
      return provider.updateDraft(
        action.draftId,
        action.rawBase64Url,
        action.threadId,
      );
    case "deleteDraft":
      return provider.deleteDraft(action.draftId);
  }
}

/**
 * Fill in the messages an action applies to.
 *
 * Callers act on a thread and pass no message IDs. Gmail is addressed per
 * thread and does not care, but IMAP has no threads: the provider has to name
 * every UID it touches, so an empty list means archive, trash, star and
 * mark-read silently never reach the server.
 *
 * Resolving here rather than in the provider keeps it ahead of the local DB
 * update — a permanent delete drops the thread, and its messages cascade with
 * it — and stores the real IDs on a queued operation, so a replay still has
 * them once those rows are gone.
 */
async function withResolvedMessageIds(
  accountId: string,
  action: EmailAction,
): Promise<EmailAction> {
  if (!("messageIds" in action) || action.messageIds.length > 0) {
    return action;
  }
  try {
    const messageIds = await getMessageIdsForThread(accountId, action.threadId);
    return { ...action, messageIds };
  } catch (err) {
    console.warn(
      `Could not resolve message IDs for thread ${action.threadId}:`,
      err,
    );
    return action;
  }
}

/** Steps 3 and 4: queue while offline, otherwise send, queueing again on a retryable error. */
async function dispatchAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(
      accountId,
      action.type,
      getResourceId(action),
      actionToParams(action),
    );
    return { success: true, queued: true };
  }

  try {
    const data = await executeViaProvider(accountId, action);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);

    if (classified.isRetryable) {
      // Queue for retry
      await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
      );
      return { success: true, queued: true };
    }

    // Permanent error — revert optimistic update
    revertOptimisticUpdate(action);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

interface UndoSpec {
  kind: string;
  describe: (count: number) => string;
}

function conversations(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/** The label an action adds to the thread, which an undo has to take off again. */
function addedLabel(action: EmailAction): string | null {
  if (action.type === "trash") return "TRASH";
  if (action.type === "spam") return action.isSpam ? "SPAM" : "INBOX";
  return null;
}

/**
 * Remember the thread's labels so an undo restores what was really there:
 * archiving from Starred must not put a thread into the inbox it was never in.
 */
async function captureRevert(
  accountId: string,
  action: EmailAction & { threadId: string },
): Promise<() => Promise<void>> {
  const db = await getDb();
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, action.threadId],
  );
  const labels = rows.map((r) => r.label_id);
  const added = addedLabel(action);
  return async () => {
    const conn = await getDb();
    for (const label of labels) {
      await conn.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, label],
      );
    }
    if (added && !labels.includes(added)) {
      await conn.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, added],
      );
    }
  };
}

/**
 * Send an action that waited out its undo window and is already in the queue.
 * Offline, or on a retryable error, the queued row stays and the processor
 * takes over; otherwise it is removed once the server has the change.
 */
async function sendQueued(
  accountId: string,
  action: EmailAction,
  opId: string,
): Promise<ActionResult> {
  if (!useUIStore.getState().isOnline) {
    await holdOperation(opId, 0);
    return { success: true, queued: true };
  }
  // Lease the row so the queue processor does not send it a second time
  // while this call is in flight; if we die here it is retried after the lease.
  await holdOperation(opId, 60);
  try {
    const data = await executeViaProvider(accountId, action);
    await deleteOperation(opId);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);
    if (classified.isRetryable) {
      await holdOperation(opId, 0);
      return { success: true, queued: true };
    }
    await deleteOperation(opId);
    revertOptimisticUpdate(action);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

export async function executeEmailAction(
  accountId: string,
  inputAction: EmailAction,
  undo?: UndoSpec,
): Promise<ActionResult> {
  // 0. Resolve the messages this action applies to (before any local mutation)
  const action = await withResolvedMessageIds(accountId, inputAction);

  let revert: (() => Promise<void>) | null = null;
  if (undo && "threadId" in action && action.threadId) {
    try {
      revert = await captureRevert(accountId, action as EmailAction & { threadId: string });
    } catch (err) {
      // Without a snapshot there is nothing to restore: run the action without undo.
      console.warn("Could not capture state for undo:", err);
    }
  }

  // 1. Optimistic UI update
  applyOptimisticUpdate(action);

  // 2. Local DB update
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  // 3. Undoable actions wait out the undo window before they leave the device.
  // The call is queued now with a delayed retry time, so it survives a quit.
  if (undo && revert) {
    try {
      const opId = await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
        Math.ceil(UNDO_WINDOW_MS / 1000) + 1,
      );
      const restoreLabels = revert;
      registerUndoable(undo.kind, undo.describe, {
        revert: async () => {
          await deleteOperation(opId);
          await restoreLabels();
        },
        commit: async () => {
          const result = await sendQueued(accountId, action, opId);
          if (!result.success) {
            logToFile("error", `Email action ${action.type} failed: ${result.error ?? "unknown error"}`);
          }
        },
      });
      return { success: true };
    } catch (err) {
      // Not queued, so not protected: send it now instead of holding it in memory.
      console.warn("Could not queue action for undo:", err);
    }
  }

  // 4. Offline queue or provider
  return dispatchAction(accountId, action);
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  // Operations queued before message IDs were resolved up front carry an empty
  // list; resolve it here so their replay still reaches the server.
  await executeViaProvider(accountId, await withResolvedMessageIds(accountId, action));
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Pass `{ undo: false }` for background work that should not raise the undo toast. */
export interface UndoOptions {
  undo?: boolean;
}

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  { undo = true }: UndoOptions = {},
): Promise<ActionResult> {
  return executeEmailAction(
    accountId,
    { type: "archive", threadId, messageIds },
    undo
      ? {
          kind: "archive",
          describe: (n) => conversations(n, "Conversation archived", "conversations archived"),
        }
      : undefined,
  );
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  { undo = true }: UndoOptions = {},
): Promise<ActionResult> {
  return executeEmailAction(
    accountId,
    { type: "trash", threadId, messageIds },
    undo
      ? {
          kind: "trash",
          describe: (n) => conversations(n, "Moved to Trash", "conversations moved to Trash"),
        }
      : undefined,
  );
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
  { undo = true }: UndoOptions = {},
): Promise<ActionResult> {
  return executeEmailAction(
    accountId,
    { type: "spam", threadId, messageIds, isSpam },
    undo
      ? {
          kind: `spam:${isSpam}`,
          describe: (n) =>
            isSpam
              ? conversations(n, "Marked as spam", "conversations marked as spam")
              : conversations(n, "Moved out of spam", "conversations moved out of spam"),
        }
      : undefined,
  );
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
  { undo = true }: UndoOptions = {},
): Promise<ActionResult> {
  return executeEmailAction(
    accountId,
    { type: "moveToFolder", threadId, messageIds, folderPath },
    undo
      ? {
          kind: `move:${folderPath}`,
          describe: (n) => conversations(n, "Conversation moved", "conversations moved"),
        }
      : undefined,
  );
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "addLabel",
    threadId,
    labelId,
  });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
  });

  // Notify the UI to refresh (so sent message appears in Sent folder)
  if (result.success) {
    window.dispatchEvent(new Event("maish-sync-done"));
  }

  return result;
}

export function createDraft(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "createDraft",
    rawBase64Url,
    threadId,
  });
}

export function updateDraft(
  accountId: string,
  draftId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "updateDraft",
    draftId,
    rawBase64Url,
    threadId,
  });
}

export function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, { type: "deleteDraft", draftId });
}
