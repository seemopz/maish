import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync, type SyncProgress } from "./sync";
import { getAccount, clearAccountHistoryId } from "../db/accounts";
import { getSetting } from "../db/settings";
import { getThreadCountForAccount, deleteAllThreadsForAccount } from "../db/threads";
import { deleteAllMessagesForAccount } from "../db/messages";
import { imapInitialSync, imapDeltaSync } from "../imap/imapSync";
import { clearAllFolderSyncStates } from "../db/folderSyncState";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import { hasCalendarSupport, getCalendarProvider } from "../calendar/providerFactory";
import { getVisibleCalendars, upsertCalendar, updateCalendarSyncToken } from "../db/calendars";
import { upsertCalendarEvent, deleteEventByRemoteId } from "../db/calendarEvents";
import { syncContactsForAccount } from "../contacts/contactSync";
import { logToFile } from "../logFile";

const SYNC_INTERVAL_MS = 60_000; // 60 seconds — delta syncs are lightweight (single API call when idle)

/** Map IMAP sync phases to the SyncProgress phases the UI understands. */
function mapImapPhase(phase: string): "labels" | "threads" | "messages" | "done" {
  if (phase === "folders") return "labels";
  if (phase === "threading" || phase === "storing_threads") return "threads";
  if (phase === "messages") return "messages";
  if (phase === "done") return "done";
  return phase as "labels" | "threads" | "messages" | "done";
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncPromise: Promise<void> | null = null;
let pendingAccountIds: string[] | null = null;
/** Accounts the periodic timer syncs; read on every tick so a deleted account drops out. */
let backgroundAccountIds: string[] = [];

export type SyncStatusCallback = (
  accountId: string,
  status: "syncing" | "done" | "error" | "removed",
  progress?: SyncProgress,
  error?: string,
) => void;

/** Several listeners: the app shell shows the status bar, the settings page its own buttons. */
const statusCallbacks = new Set<SyncStatusCallback>();
/**
 * How the last sync of each account ended: `null` for success, else the error.
 * `syncAccountInternal` reports failures through the status callback rather than
 * throwing, so a caller that waits for a run reads its verdict from here.
 */
const syncOutcomes = new Map<string, string | null>();
/**
 * Work to do directly before an account's next sync, e.g. wiping its local data
 * for a resync. It must not run earlier: a sync of the same account that is
 * already in flight would write `history_id` and the folder sync state back
 * after the wipe, and the resync would degrade to a plain delta sync.
 */
const prepareHooks = new Map<string, () => Promise<void>>();

/** Accounts deleted this session. Account ids are random UUIDs, so they are never reused. */
const removedAccountIds = new Set<string>();

/**
 * Report a status unless the account was deleted: a sync that was running when
 * the account went away would otherwise report an error (or late progress) for
 * an account that is never synced again, and nothing would clear it.
 */
function notify(...args: Parameters<SyncStatusCallback>): void {
  const [accountId, status] = args;
  if (removedAccountIds.has(accountId) && status !== "removed") return;
  for (const cb of statusCallbacks) cb(...args);
}

export function onSyncStatus(cb: SyncStatusCallback): () => void {
  statusCallbacks.add(cb);
  return () => {
    statusCallbacks.delete(cb);
  };
}

/**
 * Run a sync for a single Gmail API account (initial or delta).
 */
async function syncGmailAccount(accountId: string): Promise<void> {
  const client = await getGmailClient(accountId);
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    // Delta sync
    try {
      await deltaSync(client, accountId, account.history_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (message === "HISTORY_EXPIRED") {
        // Fallback to full sync
        await initialSync(client, accountId, syncDays, (progress) => {
          notify(accountId, "syncing", progress);
        });
      } else {
        throw err;
      }
    }
  } else {
    // First time — full initial sync
    await initialSync(client, accountId, syncDays, (progress) => {
      notify(accountId, "syncing", progress);
    });
  }
}

/**
 * Run a sync for a single IMAP account (initial or delta).
 */
async function syncImapAccount(accountId: string): Promise<void> {
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  // Refresh OAuth2 token before syncing (if applicable)
  if (account.auth_method === "oauth2") {
    await ensureFreshToken(account);
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    // Delta sync — IMAP uses folder-level UID tracking
    const result = await imapDeltaSync(accountId, syncDays);

    // Recovery: if delta sync found nothing new but the DB has no threads,
    // the previous initial sync likely failed or stored data incorrectly.
    // Force a full re-sync to recover.
    if (result.messages.length === 0) {
      const threadCount = await getThreadCountForAccount(accountId);
      if (threadCount === 0) {
        console.warn(`[syncManager] IMAP delta sync returned 0 new messages and DB has 0 threads for ${accountId} — forcing full re-sync`);
        await clearAccountHistoryId(accountId);
        await clearAllFolderSyncStates(accountId);
        await imapInitialSync(accountId, syncDays, (progress) => {
          notify(accountId, "syncing", {
            phase: mapImapPhase(progress.phase),
            current: progress.current,
            total: progress.total,
          });
        });
      }
    }
  } else {
    // First time — full initial sync
    await imapInitialSync(accountId, syncDays, (progress) => {
      notify(accountId, "syncing", {
        phase: mapImapPhase(progress.phase),
        current: progress.current,
        total: progress.total,
      });
    });
  }
}

/**
 * Sync calendars for a single account via the CalendarProvider abstraction.
 * Discovers calendars, syncs events for each visible calendar, stores results in DB.
 */
async function syncCalendarForAccount(accountId: string): Promise<void> {
  try {
    const supported = await hasCalendarSupport(accountId);
    if (!supported) return;

    const provider = await getCalendarProvider(accountId);

    // Discover/update calendars
    const calendarInfos = await provider.listCalendars();
    for (const cal of calendarInfos) {
      await upsertCalendar({
        accountId,
        provider: provider.type,
        remoteId: cal.remoteId,
        displayName: cal.displayName,
        color: cal.color,
        isPrimary: cal.isPrimary,
      });
    }

    // Sync events for each visible calendar
    const visibleCals = await getVisibleCalendars(accountId);
    for (const cal of visibleCals) {
      try {
        const syncResult = await provider.syncEvents(cal.remote_id, cal.sync_token ?? undefined);

        // Upsert created/updated events
        for (const event of [...syncResult.created, ...syncResult.updated]) {
          await upsertCalendarEvent({
            accountId,
            googleEventId: event.remoteEventId,
            summary: event.summary,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            isAllDay: event.isAllDay,
            status: event.status,
            organizerEmail: event.organizerEmail,
            attendeesJson: event.attendeesJson,
            htmlLink: event.htmlLink,
            calendarId: cal.id,
            remoteEventId: event.remoteEventId,
            etag: event.etag,
            icalData: event.icalData,
            uid: event.uid,
          });
        }

        // Delete removed events
        for (const remoteId of syncResult.deletedRemoteIds) {
          await deleteEventByRemoteId(cal.id, remoteId);
        }

        // Update sync token
        if (syncResult.newSyncToken || syncResult.newCtag) {
          await updateCalendarSyncToken(cal.id, syncResult.newSyncToken, syncResult.newCtag);
        }
      } catch (err) {
        console.warn(`[syncManager] Calendar sync failed for ${cal.display_name ?? cal.remote_id}:`, err);
      }
    }

    // Emit event for UI update
    window.dispatchEvent(new CustomEvent("maish-calendar-sync-done"));
  } catch (err) {
    console.warn(`[syncManager] Calendar sync failed for account ${accountId}:`, err);
  }
}

/**
 * Run a sync for a single account (initial or delta).
 * Routes to Gmail or IMAP sync based on account provider.
 */
async function syncAccountInternal(accountId: string): Promise<void> {
  try {
    const prepare = prepareHooks.get(accountId);
    prepareHooks.delete(accountId);
    await prepare?.();

    const account = await getAccount(accountId);

    if (!account) {
      // Deleted while a sync was queued or running — nothing to sync, nothing to report.
      syncOutcomes.delete(accountId);
      notify(accountId, "removed");
      return;
    }

    notify(accountId, "syncing");

    console.log(`[syncManager] Syncing account ${accountId} (provider=${account.provider}, history_id=${account.history_id ?? "null"})`);

    if (account.provider === "caldav" || account.provider === "carddav") {
      // DAV-only accounts carry no mailbox — sync what they do have.
      await syncCalendarForAccount(accountId);
      await syncContactsForAccount(accountId);
      syncOutcomes.set(accountId, null);
      notify(accountId, "done");
      return;
    }

    if (account.provider === "imap") {
      await syncImapAccount(accountId);
    } else {
      await syncGmailAccount(accountId);
    }

    // Always emit "done" when an initial sync completes (clears the bar).
    // Also emit for delta syncs that fell back to initial (recovery re-sync)
    // since those emit progress via statusCallback inside syncImapAccount.
    syncOutcomes.set(accountId, null);
    notify(accountId, "done");

    // Sync calendar alongside email (non-blocking — calendar errors don't affect email sync)
    syncCalendarForAccount(accountId).catch((err) => {
      console.warn(`[syncManager] Calendar sync error for ${accountId}:`, err);
    });

    // Contacts likewise: an address book that cannot be reached must not make
    // the mail sync look like it failed.
    syncContactsForAccount(accountId).catch((err) => {
      console.warn(`[syncManager] Contact sync error for ${accountId}:`, err);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    console.error(`[syncManager] Sync failed for account ${accountId}:`, message);
    logToFile("error", `[syncManager] Sync failed for account ${accountId}: ${message}`);
    syncOutcomes.set(accountId, message);
    notify(accountId, "error", undefined, message);
  }
}

async function runSync(accountIds: string[], onQueued?: () => void): Promise<void> {
  // An empty run would clear `syncPromise` before the assignment below stores it,
  // leaving a settled promise behind that every later run would queue onto.
  if (accountIds.length === 0) return;

  if (syncPromise) {
    // Queue these accounts, merging with any already-pending IDs
    const existing = new Set(pendingAccountIds ?? []);
    for (const id of accountIds) existing.add(id);
    pendingAccountIds = [...existing];
    onQueued?.();
    return syncPromise;
  }

  syncPromise = (async () => {
    try {
      for (const id of accountIds) {
        await syncAccountInternal(id);
      }
    } finally {
      syncPromise = null;
    }

    // Drain the queue — if something was queued while we were syncing, run it now
    if (pendingAccountIds) {
      const queued = pendingAccountIds;
      pendingAccountIds = null;
      await runSync(queued);
    }
  })();

  return syncPromise;
}

/**
 * Run sync for a single account, queuing if already running.
 */
export async function syncAccount(accountId: string): Promise<void> {
  return runSync([accountId]);
}

/**
 * Start the background sync timer for all accounts.
 * When `skipImmediateSync` is true the first periodic sync is deferred to the
 * next interval tick — useful when the caller already triggered a sync for a
 * newly-added account and doesn't want existing accounts to block it.
 */
export function startBackgroundSync(accountIds: string[], skipImmediateSync = false): void {
  stopBackgroundSync();
  backgroundAccountIds = [...accountIds];

  if (!skipImmediateSync) {
    // Immediate sync
    runSync(backgroundAccountIds);
  }

  // Periodic sync
  syncTimer = setInterval(() => {
    runSync(backgroundAccountIds);
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop syncing an account that was deleted. Drops it from the periodic timer
 * and the queued run, and tells the status listener to forget any failure it
 * remembers for it — otherwise the error icon would outlive the account.
 */
export function removeAccountFromSync(accountId: string): void {
  removedAccountIds.add(accountId);
  backgroundAccountIds = backgroundAccountIds.filter((id) => id !== accountId);
  if (pendingAccountIds) {
    pendingAccountIds = pendingAccountIds.filter((id) => id !== accountId);
  }
  notify(accountId, "removed");
}

/**
 * Stop the background sync timer.
 */
export function stopBackgroundSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Trigger an immediate sync for all provided accounts.
 * Waits for completion even if a background sync is in progress.
 */
export async function triggerSync(accountIds: string[]): Promise<void> {
  await runSync(accountIds);
}

export interface ResyncOptions {
  /** Called when another sync is running, so this one waits for its turn. */
  onQueued?: () => void;
}

/**
 * Run a sync and throw if any of the accounts failed, instead of resolving as
 * if it had worked. The sync itself never throws (see `syncOutcomes`).
 */
async function runSyncOrThrow(
  accountIds: string[],
  options: ResyncOptions,
  prepare: (accountId: string) => Promise<void>,
): Promise<void> {
  for (const id of accountIds) {
    const earlier = prepareHooks.get(id);
    prepareHooks.set(id, async () => {
      await earlier?.();
      await prepare(id);
    });
  }
  // A background run that is still in flight may write its own outcome first;
  // the run queued below finishes later and overwrites it.
  for (const id of accountIds) syncOutcomes.delete(id);
  await runSync(accountIds, options.onQueued);
  const failures = accountIds.flatMap((id) => {
    const error = syncOutcomes.get(id);
    return error ? [error] : [];
  });
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/**
 * Clear history IDs and perform a full re-sync for all provided accounts.
 * This re-downloads all threads from scratch. Rejects if any account fails.
 */
export async function forceFullSync(accountIds: string[], options: ResyncOptions = {}): Promise<void> {
  logToFile("info", `[syncManager] Full resync of ${accountIds.length} account(s)`);
  await runSyncOrThrow(accountIds, options, clearAccountHistoryId);
}

/**
 * Delete all local data for a single account and re-sync from scratch.
 * Removes all threads, messages, history ID, and IMAP folder sync states,
 * then runs a fresh initial sync. Rejects if the sync fails.
 */
export async function resyncAccount(accountId: string, options: ResyncOptions = {}): Promise<void> {
  logToFile("info", `[syncManager] Resync of account ${accountId}`);
  await runSyncOrThrow([accountId], options, async (id) => {
    await deleteAllThreadsForAccount(id);
    await deleteAllMessagesForAccount(id);
    await clearAccountHistoryId(id);
    await clearAllFolderSyncStates(id);
  });
}
