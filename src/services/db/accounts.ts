import { getDb, selectFirstBy } from "./connection";
import { encryptValue, decryptValue, isEncrypted } from "@/utils/crypto";

export interface DbAccount {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  history_id: string | null;
  last_sync_at: number | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  provider: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  auth_method: string;
  imap_password: string | null;
  oauth_provider: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  imap_username: string | null;
  caldav_url: string | null;
  caldav_username: string | null;
  caldav_password: string | null;
  caldav_principal_url: string | null;
  caldav_home_url: string | null;
  calendar_provider: string | null;
  accept_invalid_certs: number;
  carddav_url: string | null;
  carddav_username: string | null;
  carddav_password: string | null;
  carddav_principal_url: string | null;
  carddav_home_url: string | null;
  contacts_provider: string | null;
  /** Not a column: set when a credential could not be decrypted (the field is then null). */
  credentialError?: string;
}

const ENCRYPTED_ACCOUNT_FIELDS = [
  ["access_token", "access token"],
  ["refresh_token", "refresh token"],
  ["imap_password", "IMAP password"],
  ["oauth_client_secret", "OAuth client secret"],
  ["caldav_password", "CalDAV password"],
  ["carddav_password", "CardDAV password"],
] as const;

/**
 * Decrypts the credential columns of an account row. A value that cannot be
 * decrypted is never passed on: handing the ciphertext to a server as if it were
 * the password only produces a misleading login failure. The field is cleared
 * and the reason recorded in `credentialError`, so one bad row does not take
 * the other accounts down.
 */
async function decryptAccountTokens(account: DbAccount): Promise<DbAccount> {
  const errors: string[] = [];
  for (const [field, label] of ENCRYPTED_ACCOUNT_FIELDS) {
    const value = account[field];
    if (!value || !isEncrypted(value)) continue;
    try {
      account[field] = await decryptValue(value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      account[field] = null;
      errors.push(`Could not decrypt the ${label} of ${account.email}: ${reason}`);
    }
  }
  if (errors.length > 0) account.credentialError = errors.join("; ");
  return account;
}

/** For callers that are about to use the credentials: fail loudly instead of with empty ones. */
function requireCredentials(account: DbAccount): DbAccount {
  if (account.credentialError) throw new Error(account.credentialError);
  return account;
}

export async function getAllAccounts(): Promise<DbAccount[]> {
  const db = await getDb();
  const accounts = await db.select<DbAccount[]>(
    "SELECT * FROM accounts ORDER BY created_at ASC",
  );
  return Promise.all(accounts.map(decryptAccountTokens));
}

export async function getAccount(id: string): Promise<DbAccount | null> {
  const account = await selectFirstBy<DbAccount>(
    "SELECT * FROM accounts WHERE id = $1",
    [id],
  );
  return account ? requireCredentials(await decryptAccountTokens(account)) : null;
}

export async function getAccountByEmail(
  email: string,
): Promise<DbAccount | null> {
  const account = await selectFirstBy<DbAccount>(
    "SELECT * FROM accounts WHERE email = $1",
    [email],
  );
  return account ? requireCredentials(await decryptAccountTokens(account)) : null;
}

export async function insertAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
}): Promise<void> {
  const db = await getDb();
  const encAccessToken = await encryptValue(account.accessToken);
  const encRefreshToken = await encryptValue(account.refreshToken);
  await db.execute(
    `INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.avatarUrl,
      encAccessToken,
      encRefreshToken,
      account.tokenExpiresAt,
    ],
  );
}

export async function updateAccountTokens(
  id: string,
  accessToken: string,
  tokenExpiresAt: number,
): Promise<void> {
  const db = await getDb();
  const encAccessToken = await encryptValue(accessToken);
  await db.execute(
    "UPDATE accounts SET access_token = $1, token_expires_at = $2, updated_at = unixepoch() WHERE id = $3",
    [encAccessToken, tokenExpiresAt, id],
  );
}

export async function updateAccountSyncState(
  id: string,
  historyId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE accounts SET history_id = $1, last_sync_at = unixepoch(), updated_at = unixepoch() WHERE id = $2",
    [historyId, id],
  );
}

export async function clearAccountHistoryId(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE accounts SET history_id = NULL, updated_at = unixepoch() WHERE id = $1",
    [id],
  );
}

export async function updateAccountAllTokens(
  id: string,
  accessToken: string,
  refreshToken: string,
  tokenExpiresAt: number,
): Promise<void> {
  const db = await getDb();
  const encAccessToken = await encryptValue(accessToken);
  const encRefreshToken = await encryptValue(refreshToken);
  await db.execute(
    "UPDATE accounts SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = unixepoch() WHERE id = $4",
    [encAccessToken, encRefreshToken, tokenExpiresAt, id],
  );
}

export async function deleteAccount(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM accounts WHERE id = $1", [id]);
}

export async function insertImapAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  imapHost: string;
  imapPort: number;
  imapSecurity: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  authMethod: string;
  password: string;
  imapUsername?: string | null;
  acceptInvalidCerts?: boolean;
}): Promise<void> {
  const db = await getDb();
  const encPassword = await encryptValue(account.password);
  await db.execute(
    `INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, provider, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, auth_method, imap_password, imap_username, accept_invalid_certs)
     VALUES ($1, $2, $3, $4, NULL, NULL, 'imap', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.avatarUrl,
      account.imapHost,
      account.imapPort,
      account.imapSecurity,
      account.smtpHost,
      account.smtpPort,
      account.smtpSecurity,
      account.authMethod,
      encPassword,
      account.imapUsername || null,
      account.acceptInvalidCerts ? 1 : 0,
    ],
  );
}

export async function insertCalDavAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
  caldavPrincipalUrl?: string | null;
  caldavHomeUrl?: string | null;
}): Promise<void> {
  const db = await getDb();
  const encPassword = await encryptValue(account.caldavPassword);
  await db.execute(
    `INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, provider, calendar_provider, caldav_url, caldav_username, caldav_password, caldav_principal_url, caldav_home_url)
     VALUES ($1, $2, $3, NULL, NULL, NULL, 'caldav', 'caldav', $4, $5, $6, $7, $8)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.caldavUrl,
      account.caldavUsername,
      encPassword,
      account.caldavPrincipalUrl ?? null,
      account.caldavHomeUrl ?? null,
    ],
  );
}

/**
 * Store CalDAV settings for an address, creating the account only if needed.
 *
 * `accounts.email` is UNIQUE, and a CalDAV calendar usually belongs to an
 * address that already has a mail account — inserting a second row for it fails
 * with "UNIQUE constraint failed: accounts.email". Reports which account now
 * carries the settings so callers can tell the two cases apart.
 */
export async function saveCalDavAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
}): Promise<{ accountId: string; attachedToExisting: boolean }> {
  const existing = await getAccountByEmail(account.email);

  if (existing) {
    await updateAccountCalDav(existing.id, {
      caldavUrl: account.caldavUrl,
      caldavUsername: account.caldavUsername,
      caldavPassword: account.caldavPassword,
      calendarProvider: "caldav",
    });
    return { accountId: existing.id, attachedToExisting: true };
  }

  await insertCalDavAccount(account);
  return { accountId: account.id, attachedToExisting: false };
}

export async function updateAccountCalDav(
  accountId: string,
  fields: {
    caldavUrl: string;
    caldavUsername: string;
    caldavPassword: string;
    caldavPrincipalUrl?: string | null;
    caldavHomeUrl?: string | null;
    calendarProvider: string;
  },
): Promise<void> {
  const db = await getDb();
  const encPassword = await encryptValue(fields.caldavPassword);
  await db.execute(
    `UPDATE accounts SET caldav_url = $1, caldav_username = $2, caldav_password = $3,
       caldav_principal_url = $4, caldav_home_url = $5, calendar_provider = $6,
       updated_at = unixepoch() WHERE id = $7`,
    [
      fields.caldavUrl,
      fields.caldavUsername,
      encPassword,
      fields.caldavPrincipalUrl ?? null,
      fields.caldavHomeUrl ?? null,
      fields.calendarProvider,
      accountId,
    ],
  );
}

export async function insertCardDavAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  carddavUrl: string;
  carddavUsername: string;
  carddavPassword: string;
  carddavPrincipalUrl?: string | null;
  carddavHomeUrl?: string | null;
}): Promise<void> {
  const db = await getDb();
  const encPassword = await encryptValue(account.carddavPassword);
  await db.execute(
    `INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, provider, contacts_provider, carddav_url, carddav_username, carddav_password, carddav_principal_url, carddav_home_url)
     VALUES ($1, $2, $3, NULL, NULL, NULL, 'carddav', 'carddav', $4, $5, $6, $7, $8)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.carddavUrl,
      account.carddavUsername,
      encPassword,
      account.carddavPrincipalUrl ?? null,
      account.carddavHomeUrl ?? null,
    ],
  );
}

/**
 * Store CardDAV settings for an address, creating the account only if needed.
 *
 * The same reasoning as for `saveCalDavAccount`: `accounts.email` is UNIQUE,
 * and an address book almost always belongs to an address that already has a
 * mail account — often the very account whose CalDAV calendar is configured
 * already. Inserting a second row for it fails with "UNIQUE constraint failed:
 * accounts.email". Reports which account now carries the settings so callers
 * can tell the two cases apart.
 */
export async function saveCardDavAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  carddavUrl: string;
  carddavUsername: string;
  carddavPassword: string;
}): Promise<{ accountId: string; attachedToExisting: boolean }> {
  const existing = await getAccountByEmail(account.email);

  if (existing) {
    await updateAccountCardDav(existing.id, {
      carddavUrl: account.carddavUrl,
      carddavUsername: account.carddavUsername,
      carddavPassword: account.carddavPassword,
      contactsProvider: "carddav",
    });
    return { accountId: existing.id, attachedToExisting: true };
  }

  await insertCardDavAccount(account);
  return { accountId: account.id, attachedToExisting: false };
}

export async function updateAccountCardDav(
  accountId: string,
  fields: {
    carddavUrl: string;
    carddavUsername: string;
    carddavPassword: string;
    carddavPrincipalUrl?: string | null;
    carddavHomeUrl?: string | null;
    contactsProvider: string;
  },
): Promise<void> {
  const db = await getDb();
  const encPassword = await encryptValue(fields.carddavPassword);
  await db.execute(
    `UPDATE accounts SET carddav_url = $1, carddav_username = $2, carddav_password = $3,
       carddav_principal_url = $4, carddav_home_url = $5, contacts_provider = $6,
       updated_at = unixepoch() WHERE id = $7`,
    [
      fields.carddavUrl,
      fields.carddavUsername,
      encPassword,
      fields.carddavPrincipalUrl ?? null,
      fields.carddavHomeUrl ?? null,
      fields.contactsProvider,
      accountId,
    ],
  );
}

export async function insertOAuthImapAccount(account: {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  imapHost: string;
  imapPort: number;
  imapSecurity: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  oauthProvider: string;
  oauthClientId: string;
  oauthClientSecret: string | null;
  imapUsername?: string | null;
  acceptInvalidCerts?: boolean;
}): Promise<void> {
  const db = await getDb();
  const encAccessToken = await encryptValue(account.accessToken);
  const encRefreshToken = await encryptValue(account.refreshToken);
  const encClientSecret = account.oauthClientSecret
    ? await encryptValue(account.oauthClientSecret)
    : null;
  await db.execute(
    `INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, token_expires_at, provider, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, auth_method, imap_password, oauth_provider, oauth_client_id, oauth_client_secret, imap_username, accept_invalid_certs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'imap', $8, $9, $10, $11, $12, $13, 'oauth2', NULL, $14, $15, $16, $17, $18)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.avatarUrl,
      encAccessToken,
      encRefreshToken,
      account.tokenExpiresAt,
      account.imapHost,
      account.imapPort,
      account.imapSecurity,
      account.smtpHost,
      account.smtpPort,
      account.smtpSecurity,
      account.oauthProvider,
      account.oauthClientId,
      encClientSecret,
      account.imapUsername || null,
      account.acceptInvalidCerts ? 1 : 0,
    ],
  );
}
