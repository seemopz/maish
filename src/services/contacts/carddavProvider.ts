import { DAVClient, type DAVAddressBook, type DAVVCard } from "tsdav";
import type {
  AddressBookInfo,
  ContactCardData,
  ContactEdits,
  ContactsProvider,
  ContactsProviderType,
  ContactsSyncResult,
  CreateContactInput,
} from "./types";
import { davFetch } from "@/services/calendar/davFetch";
import { generateVCard, parseVCard } from "./vcardHelper";
import { editCard } from "./vcardEdit";
import { ContactWriteError } from "./errors";
import { getAccount } from "@/services/db/accounts";

export class CardDAVProvider implements ContactsProvider {
  readonly type: ContactsProviderType = "carddav";
  private client: DAVClient | null = null;

  constructor(readonly accountId: string) {}

  /**
   * A client of its own, separate from the CalDAV one.
   *
   * The account type decides which home set discovery looks for —
   * `addressbook-home-set` rather than `calendar-home-set` (RFC 6352 §7.1.1) —
   * and a server may well offer one service and not the other. Reusing the
   * calendar's client would look for address books under the calendar home and
   * find none.
   */
  private async getClient(): Promise<DAVClient> {
    if (this.client) return this.client;

    const account = await getAccount(this.accountId);
    if (!account) throw new Error("Account not found");

    const serverUrl = account.carddav_url;
    const username = account.carddav_username ?? account.email;
    const password = account.carddav_password;

    if (!serverUrl || !password) {
      throw new Error("CardDAV credentials not configured");
    }

    const client = new DAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "carddav",
      // DAV servers send no CORS headers, so the request has to leave the
      // webview. tsdav resolves its transport at import time and prefers
      // globalThis.fetch, which makes this per-client option the only hook
      // that reaches the actual request.
      fetch: davFetch,
    });

    // Cached only once logged in: a client whose login failed (app started
    // offline) would otherwise be reused and fail every later sync.
    await client.login();
    this.client = client;
    return client;
  }

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    const client = await this.getClient();
    const books = await client.fetchAddressBooks();
    const writable = await this.readWritableUrls(client);

    return books.map((book, index) => ({
      remoteId: withTrailingSlash(book.url),
      displayName: typeof book.displayName === "string" && book.displayName
        ? book.displayName
        : `Address Book ${index + 1}`,
      description: typeof book.description === "string" ? book.description : null,
      // Unknown privileges are taken as writable: a server that does not
      // answer the ACL property is the common case, and locking the UI down
      // on the strength of a missing answer would be worse than letting the
      // write fail with the server's own message.
      isReadOnly: writable === null ? false : !writable.has(withTrailingSlash(book.url)),
      ctag: book.ctag ?? null,
      syncToken: typeof book.syncToken === "string" ? book.syncToken : null,
    }));
  }

  /**
   * Which collections this login may write to, or null if the server did not
   * say. tsdav's own address book listing drops any property outside the
   * handful it maps, so the privileges are asked for separately.
   */
  private async readWritableUrls(client: DAVClient): Promise<Set<string> | null> {
    const home = client.account?.homeUrl;
    if (!home) return null;

    try {
      const responses = await client.propfind({
        url: home,
        props: { "d:current-user-privilege-set": {} },
        depth: "1",
      });

      const writable = new Set<string>();
      let sawPrivileges = false;

      for (const response of responses) {
        const privileges = response.props?.["currentUserPrivilegeSet"];
        if (privileges === undefined) continue;
        sawPrivileges = true;
        if (!response.href) continue;
        if (containsKey(privileges, "write") || containsKey(privileges, "write-content")) {
          writable.add(withTrailingSlash(new URL(response.href, home).href));
        }
      }

      return sawPrivileges ? writable : null;
    } catch {
      // ACL reporting is optional (RFC 3744); its absence says nothing about
      // whether a write would succeed.
      return null;
    }
  }

  async fetchContacts(addressBookRemoteId: string): Promise<ContactCardData[]> {
    const client = await this.getClient();
    const vcards = await client.fetchVCards({
      addressBook: { url: withTrailingSlash(addressBookRemoteId) } as DAVAddressBook,
    });

    return vcards
      .filter((vcard) => typeof vcard.data === "string" && vcard.data.length > 0)
      .map((vcard) => {
        const card = parseVCard(vcard.data as string, vcard.url);
        card.etag = vcard.etag ?? null;
        return card;
      });
  }

  async createContact(
    addressBookRemoteId: string,
    input: CreateContactInput,
  ): Promise<ContactCardData> {
    const client = await this.getClient();
    const uid = crypto.randomUUID();
    const filename = `${uid}.vcf`;
    const vcardData = generateVCard(input, uid);
    const collection = withTrailingSlash(addressBookRemoteId);

    const response = await client.createVCard({
      addressBook: { url: collection } as DAVAddressBook,
      filename,
      vCardString: vcardData,
    });
    assertWritten(response, "Creating the contact");

    // The same URL tsdav resolved the request against, so the stored href is
    // the one the object actually has.
    return parseVCard(vcardData, new URL(filename, collection).href);
  }

  /**
   * Patch the stored card rather than regenerate it.
   *
   * A card carries far more than a form shows — the photo, the birthday, the
   * categories another client filed it under — and rebuilding it from the
   * edited fields would drop all of it.
   */
  async updateContact(
    addressBookRemoteId: string,
    remoteContactId: string,
    edits: ContactEdits,
    etag?: string,
  ): Promise<ContactCardData> {
    const client = await this.getClient();
    const existing = await this.fetchObject(client, addressBookRemoteId, remoteContactId);
    const updated = editCard(existing.data, edits);

    await this.putCard(client, remoteContactId, updated, etag ?? existing.etag);

    const card = parseVCard(updated, remoteContactId);
    card.etag = null;
    return card;
  }

  async deleteContact(remoteContactId: string, etag?: string): Promise<void> {
    const client = await this.getClient();
    const response = await client.deleteVCard({
      vCard: { url: remoteContactId, etag: etag ?? undefined } as DAVVCard,
    });
    assertWritten(response, "Deleting the contact");
  }

  async syncContacts(addressBookRemoteId: string): Promise<ContactsSyncResult> {
    const cards = await this.fetchContacts(addressBookRemoteId);

    // The collection's ctag is what lets the next run skip an untouched book,
    // and it is read back after the fetch so a change made in between is not
    // recorded as already seen.
    const books = await this.listAddressBooks();
    const book = books.find((b) => b.remoteId === withTrailingSlash(addressBookRemoteId));

    return {
      cards,
      newCtag: book?.ctag ?? null,
      newSyncToken: book?.syncToken ?? null,
    };
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const client = await this.getClient();
      const books = await client.fetchAddressBooks();
      return {
        success: true,
        message: `Connected — found ${books.length} address book${books.length !== 1 ? "s" : ""}`,
      };
    } catch (err) {
      // Drop the client so a corrected password is picked up on the retry.
      this.client = null;
      return { success: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }

  private async fetchObject(
    client: DAVClient,
    addressBookRemoteId: string,
    remoteContactId: string,
  ): Promise<{ data: string; etag?: string }> {
    const vcards = await client.fetchVCards({
      addressBook: { url: withTrailingSlash(addressBookRemoteId) } as DAVAddressBook,
      objectUrls: [remoteContactId],
    });

    const existing = vcards[0];
    if (!existing?.data) throw new Error("Contact not found on server");
    return { data: existing.data as string, etag: existing.etag ?? undefined };
  }

  /**
   * PUT the card back, letting tsdav derive If-Match from the etag.
   *
   * Passing `headers` instead would take the conditional request away rather
   * than add to it: tsdav merges a call's parameters over the client's
   * defaults one level deep, so a `headers` argument replaces the
   * authorization header set at login and the server answers 401.
   */
  private async putCard(
    client: DAVClient,
    url: string,
    vcardData: string,
    etag?: string,
  ): Promise<void> {
    const response = await client.updateVCard({
      vCard: { url, data: vcardData, etag: etag ?? undefined } as DAVVCard,
    });
    assertWritten(response, "Saving the contact");
  }
}

/**
 * Turn a refused write into an error.
 *
 * tsdav returns whatever the server answered and throws only on a transport
 * failure, so a 401, a 403 or a 412 would otherwise pass for a saved contact.
 */
function assertWritten(response: Response, what: string): void {
  if (response.ok) return;

  if (response.status === 412) {
    throw new ContactWriteError(
      `${what} failed: it changed on the server since it was loaded`,
      412,
    );
  }

  if (response.status === 403) {
    throw new ContactWriteError(`${what} failed: this address book does not accept changes`, 403);
  }

  const detail = response.statusText
    ? `${response.status} ${response.statusText}`
    : `${response.status}`;
  throw new ContactWriteError(`${what} failed: ${detail}`, response.status);
}

/**
 * A collection URL that ends in a slash.
 *
 * tsdav resolves a new card's filename with `new URL(filename, book.url)`, and
 * a URL without a trailing slash drops its last segment when resolved against
 * — `/dav/books/default` + `x.vcf` addresses `/dav/books/x.vcf`, one level
 * above the address book. Normalising once here keeps every request and the
 * href stored alongside it pointing at the same place.
 */
export function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Whether a nested WebDAV property structure mentions the given element. */
function containsKey(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;

  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));

  for (const [name, child] of Object.entries(value)) {
    // xml-js compact output keeps namespace prefixes on element names.
    if (name === key || name.endsWith(`:${key}`)) return true;
    if (containsKey(child, key)) return true;
  }
  return false;
}

export { assertWritten };
