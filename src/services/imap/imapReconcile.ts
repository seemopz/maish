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
    // The snapshot is taken before the (slow) fetch: a flag the user sets while
    // it runs is then a difference to the snapshot, which setMessageFlags
    // refuses to overwrite, instead of a stale server value winning.
    const local = await getLocalMessagesInFolder(accountId, folderPath);
    if (local.length === 0) {
      lastReconciledAt.set(key, now);
      return none;
    }
    const busyBefore = await getResourceIdsWithOpenOps(accountId);

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

    const serverByUid = new Map(server.messages.map((m) => [m.uid, m]));
    // A thread with a local action still queued is the user's version of the
    // truth. Read on both sides of the fetch: an action sent meanwhile is gone
    // from the queue by now.
    const busy = new Set([...busyBefore, ...(await getResourceIdsWithOpenOps(accountId))]);

    const gone: typeof local = [];
    const changed: {
      id: string;
      threadId: string;
      isRead: boolean;
      isStarred: boolean;
      wasRead: boolean;
      wasStarred: boolean;
    }[] = [];
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
          wasRead: msg.is_read === 1,
          wasStarred: msg.is_starred === 1,
        });
      }
    }

    let written = 0;
    if (gone.length > 0 || changed.length > 0) {
      await withTransaction(async () => {
        const flagThreads = new Set<string>();
        for (const c of changed) {
          const applied = await setMessageFlags(
            accountId,
            c.id,
            { isRead: c.wasRead, isStarred: c.wasStarred },
            { isRead: c.isRead, isStarred: c.isStarred },
          );
          if (applied) {
            written++;
            flagThreads.add(c.threadId);
          }
        }
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
        `[imapReconcile] ${folderPath}: ${written} message(s) changed flags, ${gone.length} no longer on the server`,
      );
    }

    lastReconciledAt.set(key, now);
    return { updated: written, removed: gone.length };
  } catch (err) {
    logToFile(
      "warn",
      `[imapReconcile] ${folderPath}: flag pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`,
    );
    return none;
  }
}
