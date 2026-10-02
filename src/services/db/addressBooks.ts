import { getDb, selectFirstBy } from "./connection";

export interface DbAddressBook {
  id: string;
  account_id: string;
  provider: string;
  remote_id: string;
  display_name: string | null;
  description: string | null;
  is_read_only: number;
  is_visible: number;
  sync_token: string | null;
  ctag: string | null;
  created_at: number;
  updated_at: number;
}

export async function upsertAddressBook(book: {
  accountId: string;
  provider: string;
  remoteId: string;
  displayName: string | null;
  description: string | null;
  isReadOnly: boolean;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO address_books (id, account_id, provider, remote_id, display_name, description, is_read_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(account_id, remote_id) DO UPDATE SET
       display_name = $5, description = $6, is_read_only = $7, updated_at = unixepoch()`,
    [
      id,
      book.accountId,
      book.provider,
      book.remoteId,
      book.displayName,
      book.description,
      book.isReadOnly ? 1 : 0,
    ],
  );

  // On conflict the row keeps the id it already had, so it is read back rather
  // than assumed. `lastInsertId` is no help here: it is always 0 on the
  // transaction connection.
  const existing = await selectFirstBy<{ id: string }>(
    "SELECT id FROM address_books WHERE account_id = $1 AND remote_id = $2",
    [book.accountId, book.remoteId],
  );
  return existing?.id ?? id;
}

export async function getAddressBooksForAccount(accountId: string): Promise<DbAddressBook[]> {
  const db = await getDb();
  return db.select<DbAddressBook[]>(
    "SELECT * FROM address_books WHERE account_id = $1 ORDER BY display_name ASC",
    [accountId],
  );
}

export async function getVisibleAddressBooks(accountId: string): Promise<DbAddressBook[]> {
  const db = await getDb();
  return db.select<DbAddressBook[]>(
    "SELECT * FROM address_books WHERE account_id = $1 AND is_visible = 1 ORDER BY display_name ASC",
    [accountId],
  );
}

export async function getAddressBookById(id: string): Promise<DbAddressBook | null> {
  return selectFirstBy<DbAddressBook>("SELECT * FROM address_books WHERE id = $1", [id]);
}

export async function setAddressBookVisibility(id: string, visible: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE address_books SET is_visible = $1, updated_at = unixepoch() WHERE id = $2",
    [visible ? 1 : 0, id],
  );
}

export async function updateAddressBookSyncState(
  id: string,
  ctag: string | null,
  syncToken: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE address_books SET ctag = $1, sync_token = $2, updated_at = unixepoch() WHERE id = $3",
    [ctag, syncToken, id],
  );
}

/**
 * Drop the books of an account, and with them their contacts — the rows
 * reference the book with ON DELETE CASCADE, so removing an account's CardDAV
 * settings does not leave synced contacts behind with nothing to refresh them.
 */
export async function deleteAddressBooksForAccount(accountId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM address_books WHERE account_id = $1", [accountId]);
}
