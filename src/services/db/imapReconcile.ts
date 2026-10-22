import { getDb } from "./connection";

export interface LocalImapMessage {
  id: string;
  thread_id: string;
  imap_uid: number;
  is_read: number;
  is_starred: number;
}

/** Messages stored from one IMAP folder. */
export async function getLocalMessagesInFolder(
  accountId: string,
  folder: string,
): Promise<LocalImapMessage[]> {
  const db = await getDb();
  return db.select<LocalImapMessage[]>(
    `SELECT id, thread_id, imap_uid, is_read, is_starred FROM messages
      WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IS NOT NULL`,
    [accountId, folder],
  );
}

export interface MessageFlagState {
  isRead: boolean;
  isStarred: boolean;
}

/**
 * Set a message's flags only if it still has the `expected` ones, so a flag the
 * user changed since the caller read the row is not overwritten. Returns
 * whether the row was changed.
 */
export async function setMessageFlags(
  accountId: string,
  messageId: string,
  expected: MessageFlagState,
  next: MessageFlagState,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE messages SET is_read = $1, is_starred = $2
      WHERE account_id = $3 AND id = $4 AND is_read = $5 AND is_starred = $6`,
    [
      next.isRead ? 1 : 0,
      next.isStarred ? 1 : 0,
      accountId,
      messageId,
      expected.isRead ? 1 : 0,
      expected.isStarred ? 1 : 0,
    ],
  );
  return result.rowsAffected > 0;
}

/**
 * Drop messages the server no longer lists in `folder`, then bring the threads
 * they belonged to back in line: empty threads go, the rest get their read and
 * star state, count and date from the messages that are left, and lose the
 * folder's label when none of their messages is in that folder any more.
 */
export async function removeMessagesAndRefreshThreads(
  accountId: string,
  folder: string,
  folderLabelId: string,
  messageIds: string[],
  threadIds: string[],
): Promise<void> {
  const db = await getDb();
  // SQLite's variable limit is 999.
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    const placeholders = chunk.map((_, idx) => `$${idx + 2}`).join(", ");
    await db.execute(
      `DELETE FROM messages WHERE account_id = $1 AND id IN (${placeholders})`,
      [accountId, ...chunk],
    );
  }
  for (const threadId of threadIds) {
    await refreshThread(accountId, threadId, folder, folderLabelId);
  }
}

/** Recompute a thread's flags from its messages after their flags changed. */
export async function refreshThreadFlags(accountId: string, threadId: string): Promise<void> {
  await refreshThread(accountId, threadId, null, null);
}

async function refreshThread(
  accountId: string,
  threadId: string,
  folder: string | null,
  folderLabelId: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM threads
      WHERE account_id = $1 AND id = $2
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2)`,
    [accountId, threadId],
  );
  await db.execute(
    `UPDATE threads SET
       is_read = NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2 AND m.is_read = 0),
       is_starred = EXISTS (SELECT 1 FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2 AND m.is_starred = 1),
       message_count = (SELECT COUNT(*) FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2),
       last_message_at = (SELECT MAX(date) FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2)
     WHERE account_id = $1 AND id = $2`,
    [accountId, threadId],
  );
  // STARRED label follows the star flag, as emailActions keeps it.
  await db.execute(
    `DELETE FROM thread_labels
      WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2 AND m.is_starred = 1)`,
    [accountId, threadId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id)
      SELECT $1, $2, 'STARRED'
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.account_id = $1 AND m.thread_id = $2 AND m.is_starred = 1)`,
    [accountId, threadId],
  );
  if (folder !== null && folderLabelId !== null) {
    await db.execute(
      `DELETE FROM thread_labels
        WHERE account_id = $1 AND thread_id = $2 AND label_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.account_id = $1 AND m.thread_id = $2 AND m.imap_folder = $4
          )`,
      [accountId, threadId, folderLabelId, folder],
    );
  }
}
