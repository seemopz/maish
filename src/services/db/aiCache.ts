import { getDb } from "./connection";

interface AiCacheEntry {
  id: string;
  account_id: string;
  thread_id: string;
  type: string;
  content: string;
  created_at: number;
}

export async function getAiCache(
  accountId: string,
  threadId: string,
  type: string,
): Promise<string | null> {
  const db = await getDb();
  // An answer older than the thread's newest message describes a conversation
  // that has since grown. A Date header from the future is not counted, or the
  // answer would be regenerated (and billed) on every view until then.
  const rows = await db.select<AiCacheEntry[]>(
    `SELECT content FROM ai_cache c
      WHERE c.account_id = $1 AND c.thread_id = $2 AND c.type = $3
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.account_id = c.account_id AND m.thread_id = c.thread_id
             AND m.date > c.created_at * 1000 AND m.date <= unixepoch() * 1000
        )`,
    [accountId, threadId, type],
  );
  return rows[0]?.content ?? null;
}

export async function setAiCache(
  accountId: string,
  threadId: string,
  type: string,
  content: string,
): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO ai_cache (id, account_id, thread_id, type, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(account_id, thread_id, type) DO UPDATE SET
       content = $5, created_at = unixepoch()`,
    [id, accountId, threadId, type, content],
  );
}

export async function deleteAiCache(
  accountId: string,
  threadId: string,
  type: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3",
    [accountId, threadId, type],
  );
}
