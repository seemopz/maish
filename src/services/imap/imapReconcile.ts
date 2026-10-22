import { imapFetchFlags, type ImapConfig } from "./tauriCommands";
import { logToFile } from "../logFile";
import { withTransaction } from "../db/connection";
import { getResourceIdsWithOpenOps } from "../db/pendingOperations";
import {
  getLocalMessagesInFolder,
  setMessageFlags,
  removeMessagesAndRefreshThreads,
  refreshThreadFlags,
} from "../db/imapReconcile";

/**
 * A delta sync only fetches UIDs above the folder's last_uid, so a message that
 * was read, starred, deleted or moved elsewhere after it was stored is never
 * looked at again. This pass lists UID and flags of what the server holds and
 * brings the stored messages in line. Without CONDSTORE/QRESYNC the only way to
 * see an expunge is to compare the whole list, so it runs per folder at most
 * once per interval, and on the first sync after the app starts (which is what
 * catches up after the client was closed or the machine slept).
 */
const RECONCILE_INTERVAL_MS = 10 * 60_000;

const lastReconciledAt = new Map<string, number>();

/** For tests. */
export function resetReconcileClock(): void {
  lastReconciledAt.clear();
}

export interface ReconcileFolderArgs {
  accountId: string;
  config: ImapConfig;
  folderPath: string;
  /** Label the folder's messages carry on their thread. */
  folderLabelId: string;
  /** UIDVALIDITY the folder's UIDs were stored under. */
  uidvalidity: number | null;
}

export interface ReconcileResult {
  updated: number;
  removed: number;
}

/**
 * Never throws: a failed pass leaves the stored mail as it is and is retried by
 * the next sync, and must not turn the new-mail sync red.
 */
export async function reconcileFolder(args: ReconcileFolderArgs): Promise<ReconcileResult> {
  const { accountId, config, folderPath, folderLabelId, uidvalidity } = args;
  const none: ReconcileResult = { updated: 0, removed: 0 };
  const key = `${accountId}\u0000${folderPath}`;
  const now = Date.now();
  const last = lastReconciledAt.get(key);
  if (last !== undefined && now - last < RECONCILE_INTERVAL_MS) return none;

  try {
    // Nothing stored from this folder: not worth listing it.
    if ((await getLocalMessagesInFolder(accountId, folderPath)).length === 0) {
      lastReconciledAt.set(key, now);
      return none;
    }

    const server = await imapFetchFlags(config, folderPath);

    // Other UIDs now: the folder is about to be resynced from scratch, and the
    // list above says nothing about the messages stored under the old ones.
    if (uidvalidity !== null && server.uidvalidity !== uidvalidity) {
      logToFile(
        "warn",
        `[imapReconcile] ${folderPath}: UIDVALIDITY ${uidvalidity} -> ${server.uidvalidity}, skipping flag pass`,
      );
      return none;
    }

    // Read after the (slow) fetch, so a flag the user set meanwhile is in the
    // snapshot and a queued action is seen: the server list can be older.
    const local = await getLocalMessagesInFolder(accountId, folderPath);
    const serverByUid = new Map(server.messages.map((m) => [m.uid, m]));
    // A thread with a local action still queued is the user's version of the truth.
    const busy = await getResourceIdsWithOpenOps(accountId);

    const gone: typeof local = [];
    const changed: { id: string; threadId: string; isRead: boolean; isStarred: boolean }[] = [];
    for (const msg of local) {
      if (busy.has(msg.thread_id) || busy.has(msg.id)) continue;
      const remote = serverByUid.get(msg.imap_uid);
      if (!remote) {
        gone.push(msg);
      } else if ((msg.is_read === 1) !== remote.is_read || (msg.is_starred === 1) !== remote.is_starred) {
        changed.push({
          id: msg.id,
          threadId: msg.thread_id,
          isRead: remote.is_read,
          isStarred: remote.is_starred,
        });
      }
    }

    if (gone.length > 0 || changed.length > 0) {
      await withTransaction(async () => {
        for (const c of changed) await setMessageFlags(accountId, c.id, c.isRead, c.isStarred);
        const flagThreads = new Set(changed.map((c) => c.threadId));
        const goneThreads = new Set(gone.map((m) => m.thread_id));
        for (const threadId of flagThreads) {
          if (!goneThreads.has(threadId)) await refreshThreadFlags(accountId, threadId);
        }
        if (gone.length > 0) {
          await removeMessagesAndRefreshThreads(
            accountId,
            folderPath,
            folderLabelId,
            gone.map((m) => m.id),
            [...goneThreads],
          );
        }
      });
      logToFile(
        "info",
        `[imapReconcile] ${folderPath}: ${changed.length} message(s) changed flags, ${gone.length} no longer on the server`,
      );
    }

    lastReconciledAt.set(key, now);
    return { updated: changed.length, removed: gone.length };
  } catch (err) {
    logToFile(
      "warn",
      `[imapReconcile] ${folderPath}: flag pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`,
    );
    return none;
  }
}
