import { getDb, selectFirstBy } from "./connection";
import { normalizeEmail } from "@/utils/emailUtils";

/** Where a contact row came from. */
export type ContactSource = "local" | "carddav";

export interface DbContact {
  id: string;
  /**
   * The address the contact is filed under. Null only for a synced card that
   * carries none, which a mail-derived row never does.
   */
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  frequency: number;
  last_contacted_at: number | null;
  notes: string | null;
  source: ContactSource;
  /** Null for a row derived from mail headers. */
  address_book_id: string | null;
  dav_uid: string | null;
  dav_href: string | null;
  dav_etag: string | null;
  /** The card verbatim, so an edit patches it instead of rebuilding it. */
  vcard_data: string | null;
  /** JSON array of every address on the card, lower-cased. */
  dav_emails: string | null;
  dav_phones: string | null;
  organization: string | null;
  job_title: string | null;
}

export interface ContactAttachment {
  filename: string;
  mime_type: string | null;
  size: number | null;
  date: number;
}

export interface SameDomainContact {
  email: string;
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * Search contacts by email or name prefix for autocomplete.
 *
 * A synced card is filed under one address but may carry several, so the
 * secondary ones are matched through `dav_emails` — otherwise a colleague's
 * second address would be invisible to the composer even though the contact is
 * right there.
 */
export async function searchContacts(
  query: string,
  limit = 10,
): Promise<DbContact[]> {
  const db = await getDb();
  const pattern = `%${query}%`;
  return db.select<DbContact[]>(
    `SELECT * FROM contacts
     WHERE email LIKE $1 OR display_name LIKE $1 OR dav_emails LIKE $1
       OR organization LIKE $1
     ORDER BY frequency DESC, display_name ASC
     LIMIT $2`,
    [pattern, limit],
  );
}

/**
 * Get all contacts, ordered by frequency descending.
 */
export async function getAllContacts(
  limit = 500,
  offset = 0,
): Promise<DbContact[]> {
  const db = await getDb();
  return db.select<DbContact[]>(
    `SELECT * FROM contacts
     ORDER BY frequency DESC, display_name ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

/**
 * Update a contact's display name.
 */
export async function updateContact(
  id: string,
  displayName: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE contacts SET display_name = $1, updated_at = unixepoch() WHERE id = $2`,
    [displayName, id],
  );
}

/**
 * Delete a contact by ID.
 */
export async function deleteContact(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM contacts WHERE id = $1", [id]);
}

/**
 * Record that mail was exchanged with an address.
 *
 * The conflict rule between the two origins runs through here. A synced card
 * owns the identity of its addresses — name, organisation, photo all come from
 * the server and a mail header must not overwrite them — while how often and
 * how recently an address was written to is knowledge only this app has. So an
 * address a card already claims bumps that card's usage counters, and only an
 * address no card claims creates or updates a row of its own.
 *
 * Without this, every synced contact would grow a second, mail-derived row the
 * moment they sent a message, and the composer would offer the same person
 * twice.
 */
export async function upsertContact(
  email: string,
  displayName: string | null,
): Promise<void> {
  const db = await getDb();
  const normalized = normalizeEmail(email);

  const owner = await findDavContactByEmail(normalized);
  if (owner) {
    await db.execute(
      `UPDATE contacts SET frequency = frequency + 1,
         last_contacted_at = unixepoch(), updated_at = unixepoch()
       WHERE id = $1`,
      [owner.id],
    );
    return;
  }

  const id = crypto.randomUUID();
  // The conflict target names the partial index, which is the only uniqueness
  // that survives now that a synced card may repeat an address.
  await db.execute(
    `INSERT INTO contacts (id, email, display_name, last_contacted_at)
     VALUES ($1, $2, $3, unixepoch())
     ON CONFLICT(email) WHERE address_book_id IS NULL DO UPDATE SET
       display_name = COALESCE($3, display_name),
       frequency = frequency + 1,
       last_contacted_at = unixepoch(),
       updated_at = unixepoch()`,
    [id, normalized, displayName],
  );
}

/**
 * The synced card that claims an address, if any.
 *
 * A card is filed under one address but may list several, so the secondary
 * ones are matched through the JSON array the sync wrote.
 */
export async function findDavContactByEmail(email: string): Promise<DbContact | null> {
  const normalized = normalizeEmail(email);
  return selectFirstBy<DbContact>(
    `SELECT * FROM contacts
     WHERE address_book_id IS NOT NULL AND (email = $1 OR dav_emails LIKE $2)
     ORDER BY frequency DESC
     LIMIT 1`,
    [normalized, `%"${normalized}"%`],
  );
}

/** The mail-derived row for an address, if one exists. */
export async function findLocalContactByEmail(email: string): Promise<DbContact | null> {
  return selectFirstBy<DbContact>(
    "SELECT * FROM contacts WHERE address_book_id IS NULL AND email = $1 LIMIT 1",
    [normalizeEmail(email)],
  );
}

/**
 * The contact for an address, preferring the synced card over the row that
 * mail alone produced.
 */
export async function getContactByEmail(
  email: string,
): Promise<DbContact | null> {
  const normalized = normalizeEmail(email);
  return selectFirstBy<DbContact>(
    `SELECT * FROM contacts
     WHERE email = $1 OR dav_emails LIKE $2
     ORDER BY address_book_id IS NULL, frequency DESC
     LIMIT 1`,
    [normalized, `%"${normalized}"%`],
  );
}

export interface ContactStats {
  emailCount: number;
  firstEmail: number | null;
  lastEmail: number | null;
}

export async function getContactStats(
  email: string,
): Promise<ContactStats> {
  const db = await getDb();
  const rows = await db.select<{ cnt: number; first_date: number | null; last_date: number | null }[]>(
    `SELECT COUNT(*) as cnt, MIN(date) as first_date, MAX(date) as last_date
     FROM messages WHERE from_address = $1`,
    [normalizeEmail(email)],
  );
  const row = rows[0];
  return {
    emailCount: row?.cnt ?? 0,
    firstEmail: row?.first_date ?? null,
    lastEmail: row?.last_date ?? null,
  };
}

export async function getRecentThreadsWithContact(
  email: string,
  limit = 5,
): Promise<{ thread_id: string; subject: string | null; last_message_at: number | null }[]> {
  const db = await getDb();
  return db.select(
    `SELECT DISTINCT t.id as thread_id, t.subject, t.last_message_at
     FROM threads t
     INNER JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
     WHERE m.from_address = $1
     ORDER BY t.last_message_at DESC
     LIMIT $2`,
    [normalizeEmail(email), limit],
  );
}

export async function updateContactAvatar(
  email: string,
  avatarUrl: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE contacts SET avatar_url = $1, updated_at = unixepoch() WHERE email = $2",
    [avatarUrl, normalizeEmail(email)],
  );
}

/**
 * Update a contact's notes by email.
 */
export async function updateContactNotes(
  email: string,
  notes: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE contacts SET notes = $1, updated_at = unixepoch() WHERE email = $2",
    [notes || null, normalizeEmail(email)],
  );
}

/**
 * Get recent non-inline attachments from a contact.
 */
export async function getAttachmentsFromContact(
  email: string,
  limit = 5,
): Promise<ContactAttachment[]> {
  const db = await getDb();
  return db.select<ContactAttachment[]>(
    `SELECT a.filename, a.mime_type, a.size, m.date
     FROM attachments a
     INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
     WHERE m.from_address = $1 AND a.is_inline = 0 AND a.filename IS NOT NULL
     ORDER BY m.date DESC
     LIMIT $2`,
    [normalizeEmail(email), limit],
  );
}

const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
  "live.com", "yahoo.com", "yahoo.co.uk", "aol.com", "icloud.com",
  "me.com", "mac.com", "protonmail.com", "proton.me", "mail.com",
  "zoho.com", "yandex.com", "gmx.com", "gmx.net",
]);

/**
 * Get other contacts from the same email domain (e.g., colleagues).
 * Skips public email providers.
 */
export async function getContactsFromSameDomain(
  email: string,
  limit = 5,
): Promise<SameDomainContact[]> {
  const normalized = normalizeEmail(email);
  const atIdx = normalized.indexOf("@");
  if (atIdx === -1) return [];

  const domain = normalized.slice(atIdx + 1);
  if (PUBLIC_DOMAINS.has(domain)) return [];

  const db = await getDb();
  return db.select<SameDomainContact[]>(
    `SELECT email, display_name, avatar_url FROM contacts
     WHERE email LIKE $1 AND email != $2
     ORDER BY frequency DESC
     LIMIT $3`,
    [`%@${domain}`, normalized, limit],
  );
}

/**
 * Get the most recent auth_results JSON string for messages from this sender.
 */
export async function getLatestAuthResult(
  email: string,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ auth_results: string | null }[]>(
    `SELECT auth_results FROM messages
     WHERE from_address = $1 AND auth_results IS NOT NULL
     ORDER BY date DESC LIMIT 1`,
    [normalizeEmail(email)],
  );
  return rows[0]?.auth_results ?? null;
}

// ---------------------------------------------------------------------------
// Synced contacts
// ---------------------------------------------------------------------------

export interface DavContactFields {
  addressBookId: string;
  /** The card's UID, or its URL where the card carries none. */
  davUid: string;
  davHref: string;
  davEtag: string | null;
  vcardData: string;
  displayName: string | null;
  /** The address the card is filed under, already normalised. */
  email: string | null;
  /** Every address on the card, lower-cased. */
  emails: string[];
  phones: string[];
  organization: string | null;
  jobTitle: string | null;
  note: string | null;
  avatarUrl: string | null;
}

/**
 * Store a card the sync fetched.
 *
 * Identity comes from the server on every run, so the update list is
 * deliberately complete — a name removed on the server disappears here too.
 * What it must never touch is `frequency` and `last_contacted_at`: those
 * record mail traffic this app observed, and no server knows them.
 */
export async function upsertDavContact(fields: DavContactFields): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();

  await db.execute(
    `INSERT INTO contacts (
       id, email, display_name, avatar_url, notes, source, address_book_id,
       dav_uid, dav_href, dav_etag, vcard_data, dav_emails, dav_phones,
       organization, job_title
     )
     VALUES ($1, $2, $3, $4, $5, 'carddav', $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT(address_book_id, dav_uid) WHERE address_book_id IS NOT NULL DO UPDATE SET
       email = $2,
       display_name = $3,
       avatar_url = $4,
       notes = $5,
       dav_href = $8,
       dav_etag = $9,
       vcard_data = $10,
       dav_emails = $11,
       dav_phones = $12,
       organization = $13,
       job_title = $14,
       updated_at = unixepoch()`,
    [
      id,
      fields.email,
      fields.displayName,
      fields.avatarUrl,
      fields.note,
      fields.addressBookId,
      fields.davUid,
      fields.davHref,
      fields.davEtag,
      fields.vcardData,
      JSON.stringify(fields.emails),
      JSON.stringify(fields.phones),
      fields.organization,
      fields.jobTitle,
    ],
  );

  const stored = await selectFirstBy<{ id: string }>(
    "SELECT id FROM contacts WHERE address_book_id = $1 AND dav_uid = $2",
    [fields.addressBookId, fields.davUid],
  );
  return stored?.id ?? id;
}

/**
 * Fold a mail-derived row into the synced card that now claims its address.
 *
 * The two rows describe one person, and leaving both would show them twice in
 * every list. What the local row knows that the card does not — how often and
 * how recently mail was exchanged, and since when — is carried across;
 * everything else the card already states better. The caller settles the note
 * beforehand, since that is the one field both sides may hold different text
 * in.
 */
export async function absorbLocalContact(
  davContactId: string,
  localContactId: string,
): Promise<void> {
  const db = await getDb();

  const rows = await db.select<UsageRow[]>(
    `SELECT id, frequency, last_contacted_at, first_contacted_at
     FROM contacts WHERE id IN ($1, $2)`,
    [davContactId, localContactId],
  );

  const card = rows.find((r) => r.id === davContactId);
  const local = rows.find((r) => r.id === localContactId);
  if (!card || !local) return;

  await db.execute(
    `UPDATE contacts SET frequency = $1, last_contacted_at = $2,
       first_contacted_at = $3, updated_at = unixepoch()
     WHERE id = $4`,
    [
      card.frequency + local.frequency,
      latest(card.last_contacted_at, local.last_contacted_at),
      earliest(card.first_contacted_at, local.first_contacted_at),
      davContactId,
    ],
  );

  await db.execute("DELETE FROM contacts WHERE id = $1 AND address_book_id IS NULL", [
    localContactId,
  ]);
}

interface UsageRow {
  id: string;
  frequency: number;
  last_contacted_at: number | null;
  first_contacted_at: number | null;
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export async function getContactById(id: string): Promise<DbContact | null> {
  return selectFirstBy<DbContact>("SELECT * FROM contacts WHERE id = $1", [id]);
}

/**
 * Remove the cards of a book that the server no longer lists.
 *
 * A deletion made in another client is only ever visible as an absence, so the
 * rows that survive a run are the ones the fetch reported. Passing an empty
 * list would clear the book, which is why the caller must skip a failed fetch
 * rather than treat it as "nothing there".
 */
export async function deleteDavContactsMissingFrom(
  addressBookId: string,
  keptUids: string[],
): Promise<number> {
  const db = await getDb();

  if (keptUids.length === 0) {
    const result = await db.execute("DELETE FROM contacts WHERE address_book_id = $1", [
      addressBookId,
    ]);
    return result.rowsAffected;
  }

  const placeholders = keptUids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await db.execute(
    `DELETE FROM contacts
     WHERE address_book_id = $1 AND dav_uid NOT IN (${placeholders})`,
    [addressBookId, ...keptUids],
  );
  return result.rowsAffected;
}

/**
 * Record what a write left on the server.
 *
 * The etag comes back null after a write here: the response's own etag is not
 * something tsdav surfaces, and a stale one would make the next edit fail its
 * If-Match. A null sends the next edit without the precondition, and the
 * following sync fills it in again.
 */
export async function updateDavContactCard(
  contactId: string,
  fields: {
    vcardData: string;
    etag: string | null;
    displayName: string | null;
    email: string | null;
    emails: string[];
    phones: string[];
    organization: string | null;
    jobTitle: string | null;
    note: string | null;
  },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE contacts SET vcard_data = $1, dav_etag = $2, display_name = $3,
       email = $4, dav_emails = $5, dav_phones = $6, organization = $7,
       job_title = $8, notes = $9, updated_at = unixepoch()
     WHERE id = $10`,
    [
      fields.vcardData,
      fields.etag,
      fields.displayName,
      fields.email,
      JSON.stringify(fields.emails),
      JSON.stringify(fields.phones),
      fields.organization,
      fields.jobTitle,
      fields.note,
      contactId,
    ],
  );
}
