import type { ContactsProvider } from "./types";
import { CardDAVProvider } from "./carddavProvider";
import { findAccount, getAccount } from "@/services/db/accounts";

const providerCache = new Map<string, ContactsProvider>();

/**
 * Get a ContactsProvider for the given account.
 *
 * Routes on `account.contacts_provider`, or on `provider` for an account that
 * exists only for its address book. CardDAV is the sole implementation: Gmail
 * contacts live behind the People API rather than a DAV endpoint, so a Gmail
 * account without explicit CardDAV settings has no contacts provider at all.
 */
export async function getContactsProvider(accountId: string): Promise<ContactsProvider> {
  const cached = providerCache.get(accountId);
  if (cached) return cached;

  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);

  if (account.provider !== "carddav" && !(account.contacts_provider === "carddav" && account.carddav_url)) {
    throw new Error(`No contacts provider configured for account ${accountId}`);
  }

  const provider = new CardDAVProvider(accountId);
  providerCache.set(accountId, provider);
  return provider;
}

/** Whether an account has contact syncing configured. */
export async function hasContactsSupport(accountId: string): Promise<boolean> {
  const account = await findAccount(accountId);
  if (!account) return false;

  if (account.provider === "carddav") return true;
  return account.contacts_provider === "carddav" && !!account.carddav_url;
}

/**
 * Drop the cached provider, which holds a logged-in DAV client. Changed
 * credentials only take effect once the old client is gone.
 */
export function removeContactsProvider(accountId: string): void {
  providerCache.delete(accountId);
}

export function clearAllContactsProviders(): void {
  providerCache.clear();
}
