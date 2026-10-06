/**
 * Finding a CardDAV endpoint for an address.
 *
 * The shape follows the calendar's `discoverCalDavSettings`: known providers
 * first, then RFC 6764 well-known discovery, then the path Nextcloud serves
 * DAV under. What differs is only the service name — `/.well-known/carddav`
 * rather than `/.well-known/caldav` — and that a server offering one service
 * need not offer the other.
 */
import { davFetch } from "@/services/calendar/davFetch";
import { findAccountByEmail } from "@/services/db/accounts";

interface CardDavPreset {
  name: string;
  domains: string[];
  carddavUrl: string;
  authMethod: "basic" | "oauth2";
  needsAppPassword?: boolean;
}

const PRESETS: CardDavPreset[] = [
  {
    name: "Google",
    domains: ["gmail.com", "googlemail.com", "google.com"],
    carddavUrl: "https://www.googleapis.com/carddav/v1/principals/",
    authMethod: "oauth2",
  },
  {
    name: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    carddavUrl: "https://contacts.icloud.com",
    authMethod: "basic",
    needsAppPassword: true,
  },
  {
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
    carddavUrl: "https://carddav.fastmail.com/",
    authMethod: "basic",
    needsAppPassword: true,
  },
  {
    name: "Zoho",
    domains: ["zoho.com", "zohomail.com"],
    carddavUrl: "https://contacts.zoho.com/carddav/",
    authMethod: "basic",
  },
  {
    name: "GMX",
    domains: ["gmx.com", "gmx.net", "gmx.de"],
    carddavUrl: "https://carddav.gmx.net/",
    authMethod: "basic",
  },
];

export interface CardDavDiscoveryResult {
  providerName: string | null;
  carddavUrl: string | null;
  authMethod: "basic" | "oauth2";
  needsAppPassword: boolean;
}

const EMPTY: CardDavDiscoveryResult = {
  providerName: null,
  carddavUrl: null,
  authMethod: "basic",
  needsAppPassword: false,
};

/**
 * Discover CardDAV settings from an email address.
 * Matches known providers by domain, or attempts .well-known/carddav discovery.
 */
export async function discoverCardDavSettings(email: string): Promise<CardDavDiscoveryResult> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return EMPTY;

  for (const preset of PRESETS) {
    if (preset.domains.includes(domain)) {
      return {
        providerName: preset.name,
        carddavUrl: preset.carddavUrl,
        authMethod: preset.authMethod,
        needsAppPassword: preset.needsAppPassword ?? false,
      };
    }
  }

  const hosts = await candidateHosts(email, domain);

  for (const host of hosts) {
    const wellKnownUrl = await tryWellKnownDiscovery(host);
    if (wellKnownUrl) {
      return { ...EMPTY, carddavUrl: wellKnownUrl };
    }
  }

  for (const host of hosts) {
    const nextcloudUrl = await tryNextcloudDiscovery(host);
    if (nextcloudUrl) {
      return { ...EMPTY, providerName: "Nextcloud", carddavUrl: nextcloudUrl };
    }
  }

  return EMPTY;
}

/**
 * Hosts worth probing for this address, most likely first.
 *
 * Deriving the host from the address alone only holds where mail domain and
 * server domain coincide. Self-hosted setups routinely split them — the
 * address lives on a bare domain that serves no .well-known, while the DAV
 * endpoint sits on the mail server, whose host is already known from the IMAP
 * setup.
 */
async function candidateHosts(email: string, domain: string): Promise<string[]> {
  const hosts = [domain];

  const account = await findAccountByEmail(email).catch(() => null);
  const mailHost = account?.imap_host?.toLowerCase();
  if (mailHost && !hosts.includes(mailHost)) hosts.push(mailHost);

  // A server that already answers for calendars answers for contacts from the
  // same host often enough to be worth trying before giving up.
  const calendarHost = hostOf(account?.caldav_url);
  if (calendarHost && !hosts.includes(calendarHost)) hosts.push(calendarHost);

  return hosts;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function tryWellKnownDiscovery(domain: string): Promise<string | null> {
  try {
    // DAV hosts serve no CORS headers — go through the Rust HTTP client, and
    // ask it not to follow the redirect, which is the answer being looked for.
    const response = await davFetch(`https://${domain}/.well-known/carddav`, {
      method: "GET",
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (location) {
        return location.startsWith("/") ? `https://${domain}${location}` : location;
      }
    }

    // Some servers answer at the well-known URL directly.
    if (response.ok) return `https://${domain}/.well-known/carddav`;
  } catch {
    // Discovery failed — not all servers support this.
  }
  return null;
}

async function tryNextcloudDiscovery(domain: string): Promise<string | null> {
  try {
    const response = await davFetch(`https://${domain}/remote.php/dav/`, { method: "OPTIONS" });
    // 401 means the endpoint is there and wants credentials.
    if (response.ok || response.status === 401) return `https://${domain}/remote.php/dav/`;
  } catch {
    // Not a Nextcloud instance.
  }
  return null;
}

/**
 * Test CardDAV credentials, reporting how many address books they reach.
 */
export async function testCardDavConnection(
  url: string,
  username: string,
  password: string,
): Promise<{ success: boolean; message: string; addressBookCount?: number }> {
  try {
    const { DAVClient } = await import("tsdav");
    const client = new DAVClient({
      serverUrl: url,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "carddav",
      fetch: davFetch,
    });

    await client.login();
    const books = await client.fetchAddressBooks();

    return {
      success: true,
      message: `Connected — found ${books.length} address book${books.length !== 1 ? "s" : ""}`,
      addressBookCount: books.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return { success: false, message };
  }
}
