import type { ImapConfig, ImapMessage, DeltaCheckRequest, DeltaCheckResult } from "./tauriCommands";
import {
  imapListFolders,
  imapGetFolderStatus,
  imapFetchMessages,
  imapFetchNewUids,
  imapSearchFolder,
  imapDeltaCheck,
} from "./tauriCommands";
import { buildImapConfig } from "./imapConfigBuilder";
import {
  mapFolderToLabel,
  getLabelsForMessage,
  syncFoldersToLabels,
  getSyncableFolders,
} from "./folderMapper";
import type { ParsedMessage, ParsedAttachment } from "../gmail/messageParser";
import type { SyncResult } from "../email/types";
import {
  upsertMessage,
  updateMessageThreadIds,
  getMessagesForThread,
  deleteMessagesInFolder,
} from "../db/messages";
import {
  upsertThread,
  setThreadLabels,
  deleteThread,
  getThreadLabelIds,
  getThreadById,
  deleteEmptyThreads,
} from "../db/threads";
import { upsertAttachment } from "../db/attachments";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { withTransaction } from "../db/connection";
import {
  upsertFolderSyncState,
  getAllFolderSyncStates,
  type FolderSyncState,
} from "../db/folderSyncState";
import {
  buildThreads,
  type ThreadableMessage,
  type ThreadGroup,
} from "../threading/threadBuilder";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { sha256Hex } from "../../utils/sha256";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
/** Number of messages to fetch per IPC call during initial sync. */
const CHUNK_SIZE = 200;
/** Number of thread groups to process per transaction in Phase 4. */
const THREAD_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Circuit breaker for connection storms
// ---------------------------------------------------------------------------

/** After this many consecutive connection failures, add a cooldown delay. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Delay (ms) to wait after hitting the circuit breaker threshold. */
const CIRCUIT_BREAKER_DELAY_MS = 15_000;
/** After this many consecutive failures, skip remaining folders entirely. */
const CIRCUIT_BREAKER_MAX_FAILURES = 5;
/** Delay (ms) between folder syncs during initial sync to avoid connection bursts. */
const INTER_FOLDER_DELAY_MS = 1_000;

export function isConnectionError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("tcp") ||
    msg.includes("tls") ||
    msg.includes("dns") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// IMAP SINCE date helpers
// ---------------------------------------------------------------------------

const IMAP_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Format a Date as `DD-Mon-YYYY` for the IMAP SINCE search criterion (RFC 3501 §6.4.4).
 */
export function formatImapDate(date: Date): string {
  const day = date.getUTCDate();
  const month = IMAP_MONTH_NAMES[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Compute a `DD-Mon-YYYY` SINCE date string for the given `daysBack` value.
 * Subtracts an extra day as a safety margin for timezone differences
 * (IMAP SINCE has date-only granularity, no time component).
 */
export function computeSinceDate(daysBack: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack - 1);
  return formatImapDate(date);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ImapSyncProgress {
  phase: "folders" | "messages" | "threading" | "storing_threads" | "done";
  current: number;
  total: number;
  folder?: string;
}

export type ImapSyncProgressCallback = (progress: ImapSyncProgress) => void;

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic Message-ID for messages that lack one.
 *
 * The result is stored in `messages.message_id_header` and threading matches
 * against it, so the format has to stay stable — changing it strands every
 * message already stored under the old form in its own thread.
 */
function syntheticMessageId(accountId: string, folder: string, uid: number): string {
  return `synthetic-${accountId}-${folder}-${uid}@maish.local`;
}

/**
 * Convert an ImapMessage (from Tauri backend) to the ParsedMessage format
 * used throughout the app.
 */
export function imapMessageToParsedMessage(
  msg: ImapMessage,
  accountId: string,
  folderLabelId: string,
): { parsed: ParsedMessage; threadable: ThreadableMessage } {
  const messageId = `imap-${accountId}-${msg.folder}-${msg.uid}`;
  const rfc2822MessageId =
    msg.message_id ?? syntheticMessageId(accountId, msg.folder, msg.uid);

  const folderMapping = { labelId: folderLabelId, labelName: "", type: "" };
  const labelIds = getLabelsForMessage(
    folderMapping,
    msg.is_read,
    msg.is_starred,
    msg.is_draft,
  );

  const snippet = msg.snippet ?? (msg.body_text ? msg.body_text.slice(0, 200) : "");

  const attachments: ParsedAttachment[] = msg.attachments.map((att) => ({
    filename: att.filename,
    mimeType: att.mime_type,
    size: att.size,
    gmailAttachmentId: att.part_id, // reuse field for IMAP part ID
    contentId: att.content_id,
    isInline: att.is_inline,
  }));

  const parsed: ParsedMessage = {
    id: messageId,
    threadId: "", // will be assigned after threading
    fromAddress: msg.from_address,
    fromName: msg.from_name,
    toAddresses: msg.to_addresses,
    ccAddresses: msg.cc_addresses,
    bccAddresses: msg.bcc_addresses,
    replyTo: msg.reply_to,
    subject: msg.subject,
    snippet,
    date: msg.date * 1000,
    isRead: msg.is_read,
    isStarred: msg.is_starred,
    bodyHtml: msg.body_html,
    bodyText: msg.body_text,
    rawSize: msg.raw_size,
    internalDate: msg.date * 1000,
    labelIds,
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: msg.list_unsubscribe,
    listUnsubscribePost: msg.list_unsubscribe_post,
    authResults: msg.auth_results,
  };

  const threadable: ThreadableMessage = {
    id: messageId,
    messageId: rfc2822MessageId,
    inReplyTo: msg.in_reply_to,
    references: msg.references,
    subject: msg.subject,
    date: msg.date * 1000,
    fromAddress: msg.from_address,
    contentKey: sha256Hex(msg.body_text ?? msg.body_html ?? ""),
  };

  return { parsed, threadable };
}

// ---------------------------------------------------------------------------
// Thread storage
// ---------------------------------------------------------------------------

/**
 * Store threads and their messages into the local DB.
 *
 * `skippedMessageIds` holds the messages of every thread that was left alone
 * because a local operation on it is still pending. They are not stored, so the
 * caller may not record their UIDs as synced.
 */
async function storeThreadsAndMessages(
  accountId: string,
  threadGroups: ThreadGroup[],
  parsedByLocalId: Map<string, ParsedMessage>,
  imapMsgByLocalId: Map<string, ImapMessage>,
  labelsByRfcId?: Map<string, Set<string>>,
): Promise<{ storedMessages: ParsedMessage[]; skippedMessageIds: Set<string> }> {
  const storedMessages: ParsedMessage[] = [];
  const skippedMessageIds = new Set<string>();

  // Pre-check pending ops OUTSIDE any transaction
  const skippedThreadIds = new Set<string>();
  for (const group of threadGroups) {
    const pendingOps = await getPendingOpsForResource(accountId, group.threadId);
    if (pendingOps.length > 0) {
      console.log(`[imapSync] Skipping thread ${group.threadId}: has ${pendingOps.length} pending local ops`);
      skippedThreadIds.add(group.threadId);
      for (const id of group.messageIds) skippedMessageIds.add(id);
    }
  }

  // Process in batches within transactions to avoid long-held locks
  for (let i = 0; i < threadGroups.length; i += THREAD_BATCH_SIZE) {
    const batch = threadGroups.slice(i, i + THREAD_BATCH_SIZE);

    await withTransaction(async () => {
      for (const group of batch) {
        if (skippedThreadIds.has(group.threadId)) continue;

        const messages = group.messageIds
          .map((id) => parsedByLocalId.get(id))
          .filter((m): m is ParsedMessage => m !== undefined);

        if (messages.length === 0) continue;

        // Assign threadId to each message
        for (const msg of messages) {
          msg.threadId = group.threadId;
        }

        // Sort by date ascending
        messages.sort((a, b) => a.date - b.date);

        const firstMessage = messages[0]!;
        const lastMessage = messages[messages.length - 1]!;

        // Collect all label IDs across messages in this thread.
        // Also include labels from duplicate folder copies (same RFC Message-ID
        // in multiple folders) that the threading algorithm may have deduplicated.
        const allLabelIds = new Set<string>();
        for (const msg of messages) {
          for (const lid of msg.labelIds) {
            allLabelIds.add(lid);
          }
          // Merge labels from all folder copies of this message
          const imapMsg = imapMsgByLocalId.get(msg.id);
          const rfcId = imapMsg?.message_id;
          if (rfcId && labelsByRfcId) {
            const extraLabels = labelsByRfcId.get(rfcId);
            if (extraLabels) {
              for (const lid of extraLabels) {
                allLabelIds.add(lid);
              }
            }
          }
        }

        // The thread row has to exist before its messages, because
        // messages.thread_id is a foreign key onto it. This first write only
        // satisfies that: it describes the batch, which on a delta sync is
        // one reply out of a conversation that may already hold a dozen
        // messages. The real aggregate is computed further down, once the
        // messages are in and the whole thread can be read back.
        await upsertThread({
          id: group.threadId,
          accountId,
          subject: firstMessage.subject,
          snippet: lastMessage.snippet,
          lastMessageAt: lastMessage.date,
          messageCount: messages.length,
          isRead: messages.every((m) => m.isRead),
          isStarred: messages.some((m) => m.isStarred),
          isImportant: false,
          hasAttachments: messages.some((m) => m.hasAttachments),
        });

        // Store messages sequentially to avoid concurrent DB writes
        for (const parsed of messages) {
          const imapMsg = imapMsgByLocalId.get(parsed.id);

          await upsertMessage({
            id: parsed.id,
            accountId,
            threadId: parsed.threadId,
            fromAddress: parsed.fromAddress,
            fromName: parsed.fromName,
            toAddresses: parsed.toAddresses,
            ccAddresses: parsed.ccAddresses,
            bccAddresses: parsed.bccAddresses,
            replyTo: parsed.replyTo,
            subject: parsed.subject,
            snippet: parsed.snippet,
            date: parsed.date,
            isRead: parsed.isRead,
            isStarred: parsed.isStarred,
            bodyHtml: parsed.bodyHtml,
            bodyText: parsed.bodyText,
            rawSize: parsed.rawSize,
            internalDate: parsed.internalDate,
            listUnsubscribe: parsed.listUnsubscribe,
            listUnsubscribePost: parsed.listUnsubscribePost,
            authResults: parsed.authResults,
            messageIdHeader: imapMsg?.message_id ?? null,
            referencesHeader: imapMsg?.references ?? null,
            inReplyToHeader: imapMsg?.in_reply_to ?? null,
            imapUid: imapMsg?.uid ?? null,
            imapFolder: imapMsg?.folder ?? null,
          });

          for (const att of parsed.attachments) {
            await upsertAttachment({
              id: `${parsed.id}_${att.gmailAttachmentId}`,
              messageId: parsed.id,
              accountId,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              gmailAttachmentId: att.gmailAttachmentId,
              contentId: att.contentId,
              isInline: att.isInline,
            });
          }

          storedMessages.push(parsed);
        }

        // Now that this batch is stored, describe the thread from every
        // message it actually has. Delta sync fetches only what is new and
        // threads only what it fetched, so deriving the row from the batch
        // left a five-message conversation counted as one, unstarred because
        // the star sits on a message that was not re-fetched, and re-titled
        // after the reply's "Re:" subject.
        const stored = await getMessagesForThread(accountId, group.threadId);
        if (stored.length > 0) {
          const oldest = stored[0]!;
          const newest = stored[stored.length - 1]!;
          const storedThread = await getThreadById(accountId, group.threadId);

          await upsertThread({
            id: group.threadId,
            accountId,
            subject: oldest.subject,
            snippet: newest.snippet,
            lastMessageAt: newest.date,
            messageCount: stored.length,
            isRead: stored.every((m) => m.is_read === 1),
            isStarred: stored.some((m) => m.is_starred === 1),
            isImportant: false,
            // An attachment never leaves a message that is already stored,
            // and the messages table does not carry the flag, so this is the
            // batch's answer OR whatever the thread already said.
            hasAttachments:
              messages.some((m) => m.hasAttachments) ||
              storedThread?.has_attachments === 1,
          });
        }

        // Union rather than replace. The labels derived here come from the
        // folders the batch was fetched from; a label the user applied, or
        // one carried by a message that was not re-fetched, is in neither and
        // was being deleted on every sync.
        const existingLabels = await getThreadLabelIds(accountId, group.threadId);
        for (const lid of existingLabels) {
          allLabelIds.add(lid);
        }
        await setThreadLabels(accountId, group.threadId, [...allLabelIds]);
      }
    });
  }

  return { storedMessages, skippedMessageIds };
}

// ---------------------------------------------------------------------------
// Fetch messages from a folder in batches
// ---------------------------------------------------------------------------

/**
 * Fetch messages from a folder in batches of BATCH_SIZE.
 */
async function fetchMessagesInBatches(
  config: ImapConfig,
  folder: string,
  uids: number[],
  onBatch?: (fetched: number, total: number) => void,
): Promise<{
  messages: ImapMessage[];
  lastUid: number;
  uidvalidity: number;
  undeliveredUids: number[];
}> {
  const allMessages: ImapMessage[] = [];
  const undeliveredUids: number[] = [];
  let lastUid = 0;
  let uidvalidity = 0;

  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const result = await imapFetchMessages(config, folder, batch);

    allMessages.push(...result.messages);
    uidvalidity = result.folder_status.uidvalidity;

    const delivered = new Set<number>();
    for (const msg of result.messages) {
      delivered.add(msg.uid);
      if (msg.uid > lastUid) lastUid = msg.uid;
    }
    // The Rust side drops a message it cannot read (a stream error, no body, a
    // parse failure) with a log line only, so the batch comes back short
    // without an error to catch.
    for (const uid of batch) {
      if (!delivered.has(uid)) undeliveredUids.push(uid);
    }

    onBatch?.(Math.min(i + BATCH_SIZE, uids.length), uids.length);
  }

  return { messages: allMessages, lastUid, uidvalidity, undeliveredUids };
}

/**
 * How many delta syncs in a row a UID was listed by the server and not
 * delivered, keyed by account, folder and UID. Held in memory: a restart
 * simply tries again.
 */
const undeliveredUidAttempts = new Map<string, number>();

/** A UID held back this many syncs is given up on, so one unreadable message cannot pin a folder. */
const MAX_UNDELIVERED_ATTEMPTS = 3;

export function resetUndeliveredUidAttempts(): void {
  undeliveredUidAttempts.clear();
}

/**
 * The UIDs of a folder that may hold its watermark back this time. Counts an
 * attempt for each; once a UID has used them all it is let go.
 */
function uidsToRetry(accountId: string, folder: string, undelivered: number[]): number[] {
  const retry: number[] = [];
  const current = new Set(undelivered);

  for (const key of [...undeliveredUidAttempts.keys()]) {
    const [acc, fold, uidText] = key.split("\u0000");
    // A UID delivered since is no longer a problem.
    if (acc === accountId && fold === folder && !current.has(Number(uidText))) {
      undeliveredUidAttempts.delete(key);
    }
  }

  for (const uid of undelivered) {
    const key = [accountId, folder, uid].join("\u0000");
    const attempts = (undeliveredUidAttempts.get(key) ?? 0) + 1;
    undeliveredUidAttempts.set(key, attempts);
    if (attempts < MAX_UNDELIVERED_ATTEMPTS) {
      retry.push(uid);
    } else {
      console.warn(
        `[imapSync] Folder ${folder}: UID ${uid} was listed but not delivered ${attempts} syncs in a row, giving up on it`,
      );
    }
  }
  return retry;
}

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

/**
 * Perform initial sync for an IMAP account.
 * Fetches messages from all folders for the past N days.
 */
export async function imapInitialSync(
  accountId: string,
  daysBack = 365,
  onProgress?: ImapSyncProgressCallback,
): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  // Phase 1: List and sync folders
  onProgress?.({ phase: "folders", current: 0, total: 1 });
  const allFolders = await imapListFolders(config);
  const syncableFolders = getSyncableFolders(allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);
  console.log(`[imapSync] Initial sync for account ${accountId}: ${syncableFolders.length} syncable folders`);
  onProgress?.({ phase: "folders", current: 1, total: 1 });

  // ---------------------------------------------------------------------------
  // Phase 2: Streaming fetch & store
  // ---------------------------------------------------------------------------
  // For each folder, for each batch: fetch → parse → store to DB immediately
  // (with placeholder threadId = messageId). Only lightweight metadata is kept
  // in memory for the subsequent threading pass.
  // This avoids accumulating all message bodies in memory (OOM on large mailboxes).

  interface MessageMeta {
    id: string;
    rfcMessageId: string;
    labelIds: string[];
    isRead: boolean;
    isStarred: boolean;
    hasAttachments: boolean;
    subject: string | null;
    snippet: string;
    date: number;
  }

  const allThreadable: ThreadableMessage[] = [];
  const allMeta = new Map<string, MessageMeta>();

  // Track RFC Message-ID → all label IDs from every folder copy.
  // This ensures labels aren't lost when the threading algorithm deduplicates
  // messages that exist in multiple IMAP folders (e.g., INBOX + Sent).
  const labelsByRfcId = new Map<string, Set<string>>();

  // Estimate total messages for progress
  let totalEstimate = 0;
  for (const folder of syncableFolders) {
    totalEstimate += folder.exists;
  }

  let fetchedTotal = 0;
  let totalMessagesFound = 0;
  let storedCount = 0;
  let consecutiveFailures = 0;
  const folderErrors: string[] = [];

  for (let folderIdx = 0; folderIdx < syncableFolders.length; folderIdx++) {
    const folder = syncableFolders[folderIdx]!;
    if (folder.exists === 0) continue;

    // Circuit breaker: skip remaining folders after too many consecutive failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive connection failures, ` +
        `skipping remaining ${syncableFolders.length - folderIdx} folders`,
      );
      break;
    }

    // Circuit breaker: add cooldown delay after threshold failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive failures, ` +
        `waiting ${CIRCUIT_BREAKER_DELAY_MS / 1000}s before next folder`,
      );
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    // Inter-folder delay to avoid connection bursts (skip before first folder)
    if (folderIdx > 0) {
      await delay(INTER_FOLDER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);

    try {
      // Phase 2a: Lightweight search — get UIDs only (no message bodies over IPC)
      const sinceDate = computeSinceDate(daysBack);
      const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
      const uidsToFetch = searchResult.uids;

      // Reset circuit breaker on success
      consecutiveFailures = 0;

      if (uidsToFetch.length === 0) continue;

      // Date filter config
      const cutoffDate = Math.floor(Date.now() / 1000) - daysBack * 86400;
      const nowSeconds = Math.floor(Date.now() / 1000);
      let dateFallbackCount = 0;
      let folderFetchedCount = 0;
      let folderStoredCount = 0;
      let lastUid = 0;
      // The lowest UID belonging to a chunk that was given up on. last_uid is
      // a watermark — delta sync asks only for UIDs above it — so it may not
      // be allowed to pass a message this run failed to fetch, even though
      // later chunks carry higher UIDs and did succeed.
      let lowestUnfetchedUid = Number.POSITIVE_INFINITY;
      const uidvalidity = searchResult.folder_status.uidvalidity;

      // Phase 2b: Fetch messages in small IPC-friendly chunks
      for (let chunkStart = 0; chunkStart < uidsToFetch.length; chunkStart += CHUNK_SIZE) {
        const chunkUids = uidsToFetch.slice(chunkStart, chunkStart + CHUNK_SIZE);
        let chunkResult;
        try {
          chunkResult = await imapFetchMessages(config, folder.raw_path, chunkUids);
        } catch (chunkErr) {
          // Retry once for transient connection errors
          if (isConnectionError(chunkErr)) {
            console.warn(`[imapSync] Chunk fetch failed in ${folder.path}, retrying in 2s:`, chunkErr);
            await delay(2_000);
            try {
              chunkResult = await imapFetchMessages(config, folder.raw_path, chunkUids);
            } catch (retryErr) {
              console.error(`[imapSync] Chunk retry failed in ${folder.path}:`, retryErr);
              lowestUnfetchedUid = Math.min(lowestUnfetchedUid, ...chunkUids);
              continue;
            }
          } else {
            console.error(`[imapSync] Failed to fetch chunk ${chunkStart}-${chunkStart + chunkUids.length} in ${folder.path}:`, chunkErr);
            lowestUnfetchedUid = Math.min(lowestUnfetchedUid, ...chunkUids);
            continue;
          }
        }

        // Collect parsed data for this chunk to write in a single transaction
        const chunkParsed: { parsed: ParsedMessage; msg: ImapMessage; threadable: ThreadableMessage }[] = [];

        for (const msg of chunkResult.messages) {
          if (msg.uid > lastUid) lastUid = msg.uid;
          folderFetchedCount++;

          // Date filter
          if (msg.date === 0) {
            dateFallbackCount++;
            msg.date = nowSeconds;
          }
          if (msg.date < cutoffDate) continue;

          const { parsed, threadable } = imapMessageToParsedMessage(
            msg,
            accountId,
            folderMapping.labelId,
          );

          parsed.threadId = parsed.id; // placeholder — updated after threading
          chunkParsed.push({ parsed, msg, threadable });
        }

        // Write entire chunk to DB in a single transaction
        if (chunkParsed.length > 0) {
          await withTransaction(async () => {
            for (const { parsed, msg } of chunkParsed) {
              // Create placeholder thread first to satisfy FK constraint
              await upsertThread({
                id: parsed.id,
                accountId,
                subject: parsed.subject,
                snippet: parsed.snippet,
                lastMessageAt: parsed.date,
                messageCount: 1,
                isRead: parsed.isRead,
                isStarred: parsed.isStarred,
                isImportant: false,
                hasAttachments: parsed.hasAttachments,
              });
              await upsertMessage({
                id: parsed.id,
                accountId,
                threadId: parsed.id,
                fromAddress: parsed.fromAddress,
                fromName: parsed.fromName,
                toAddresses: parsed.toAddresses,
                ccAddresses: parsed.ccAddresses,
                bccAddresses: parsed.bccAddresses,
                replyTo: parsed.replyTo,
                subject: parsed.subject,
                snippet: parsed.snippet,
                date: parsed.date,
                isRead: parsed.isRead,
                isStarred: parsed.isStarred,
                bodyHtml: parsed.bodyHtml,
                bodyText: parsed.bodyText,
                rawSize: parsed.rawSize,
                internalDate: parsed.internalDate,
                listUnsubscribe: parsed.listUnsubscribe,
                listUnsubscribePost: parsed.listUnsubscribePost,
                authResults: parsed.authResults,
                messageIdHeader: msg.message_id ?? null,
                referencesHeader: msg.references ?? null,
                inReplyToHeader: msg.in_reply_to ?? null,
                imapUid: msg.uid ?? null,
                imapFolder: msg.folder ?? null,
              });

              // Store attachments
              for (const att of parsed.attachments) {
                await upsertAttachment({
                  id: `${parsed.id}_${att.gmailAttachmentId}`,
                  messageId: parsed.id,
                  accountId,
                  filename: att.filename,
                  mimeType: att.mimeType,
                  size: att.size,
                  gmailAttachmentId: att.gmailAttachmentId,
                  contentId: att.contentId,
                  isInline: att.isInline,
                });
              }
            }
          });
        }

        // Keep only lightweight data in memory for threading
        for (const { parsed, threadable } of chunkParsed) {
          const meta: MessageMeta = {
            id: parsed.id,
            rfcMessageId: threadable.messageId,
            labelIds: parsed.labelIds,
            isRead: parsed.isRead,
            isStarred: parsed.isStarred,
            hasAttachments: parsed.hasAttachments,
            subject: parsed.subject,
            snippet: parsed.snippet,
            date: parsed.date,
          };
          allMeta.set(parsed.id, meta);
          allThreadable.push(threadable);

          // Build cross-folder label map
          let labels = labelsByRfcId.get(threadable.messageId);
          if (!labels) {
            labels = new Set();
            labelsByRfcId.set(threadable.messageId, labels);
          }
          for (const lid of parsed.labelIds) {
            labels.add(lid);
          }
        }

        folderStoredCount += chunkParsed.length;
        storedCount += chunkParsed.length;

        // Report progress after each chunk (not just each folder)
        onProgress?.({
          phase: "messages",
          current: fetchedTotal + Math.min(chunkStart + CHUNK_SIZE, uidsToFetch.length),
          total: totalEstimate,
          folder: folder.path,
        });
      }

      totalMessagesFound += folderFetchedCount;
      fetchedTotal += uidsToFetch.length;

      if (dateFallbackCount > 0) {
        console.warn(
          `[imapSync] Folder ${folder.path}: ${dateFallbackCount}/${folderFetchedCount} messages had unparseable dates, using current time as fallback`,
        );
      }

      console.log(
        `[imapSync] Folder ${folder.path}: ${uidsToFetch.length} UIDs, ${folderFetchedCount} fetched, ${folderStoredCount} after date filter`,
      );

      // Update folder sync state. Anything at or above a chunk that was
      // abandoned is not synced, whatever later chunks managed to fetch:
      // moving the watermark past it would leave those messages behind with
      // no sync that ever asks for them again.
      const syncedUpTo = Number.isFinite(lowestUnfetchedUid)
        ? Math.min(lastUid, lowestUnfetchedUid - 1)
        : lastUid;

      if (syncedUpTo < lastUid) {
        console.warn(
          `[imapSync] Folder ${folder.path}: a chunk was not fetched, holding last_uid at ${syncedUpTo} instead of ${lastUid} so the gap is retried`,
        );
      }

      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity,
        last_uid: syncedUpTo,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`[imapSync] Failed to sync folder ${folder.path}:`, err);
      folderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
      // Continue with next folder
    }
  }

  // If no messages were stored and every folder failed, propagate the error
  if (storedCount === 0 && folderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${folderErrors[0]}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Thread messages (lightweight — only IDs + headers in memory)
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "threading", current: 0, total: allThreadable.length });
  const threadGroups = buildThreads(allThreadable);
  console.log(
    `[imapSync] Threading: ${allThreadable.length} messages → ${threadGroups.length} thread groups`,
  );

  // ---------------------------------------------------------------------------
  // Phase 4: Create thread records + batch-update message thread IDs
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "storing_threads", current: 0, total: threadGroups.length });

  for (let batchStart = 0; batchStart < threadGroups.length; batchStart += THREAD_BATCH_SIZE) {
    const batch = threadGroups.slice(batchStart, batchStart + THREAD_BATCH_SIZE);

    // Pre-check pending ops OUTSIDE the transaction to avoid nested DB issues
    const skippedThreadIds = new Set<string>();
    for (const group of batch) {
      const pendingOps = await getPendingOpsForResource(accountId, group.threadId);
      if (pendingOps.length > 0) {
        console.log(`[imapSync] Skipping thread ${group.threadId}: has ${pendingOps.length} pending local ops`);
        skippedThreadIds.add(group.threadId);
      }
    }

    await withTransaction(async () => {
      for (const group of batch) {
        if (skippedThreadIds.has(group.threadId)) continue;

        const messages = group.messageIds
          .map((id) => allMeta.get(id))
          .filter((m): m is MessageMeta => m !== undefined);

        if (messages.length === 0) continue;

        // Sort by date ascending
        messages.sort((a, b) => a.date - b.date);

        const firstMessage = messages[0]!;
        const lastMessage = messages[messages.length - 1]!;

        // Collect all label IDs including cross-folder copies
        const allLabelIds = new Set<string>();
        for (const msg of messages) {
          for (const lid of msg.labelIds) {
            allLabelIds.add(lid);
          }
          const extraLabels = labelsByRfcId.get(msg.rfcMessageId);
          if (extraLabels) {
            for (const lid of extraLabels) {
              allLabelIds.add(lid);
            }
          }
        }

        const isRead = messages.every((m) => m.isRead);
        const isStarred = messages.some((m) => m.isStarred);
        const hasAttachments = messages.some((m) => m.hasAttachments);

        await upsertThread({
          id: group.threadId,
          accountId,
          subject: firstMessage.subject,
          snippet: lastMessage.snippet,
          lastMessageAt: lastMessage.date,
          messageCount: messages.length,
          isRead,
          isStarred,
          isImportant: false,
          hasAttachments,
        });

        await setThreadLabels(accountId, group.threadId, [...allLabelIds]);

        // Batch-update thread IDs for all messages in this thread
        const messageIds = messages.map((m) => m.id);
        await updateMessageThreadIds(accountId, messageIds, group.threadId);
      }
    });

    onProgress?.({
      phase: "storing_threads",
      current: Math.min(batchStart + THREAD_BATCH_SIZE, threadGroups.length),
      total: threadGroups.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 5: Clean up orphaned placeholder threads
  // ---------------------------------------------------------------------------
  // Phase 2 created a placeholder thread per message (threadId = messageId).
  // Phase 4 merged messages into real threads and updated message thread IDs.
  // Placeholder threads that are no longer referenced by any final thread group
  // should be deleted to avoid ghost threads in the UI.
  const finalThreadIds = new Set(threadGroups.map((g) => g.threadId));
  const allMessageIds = new Set(allMeta.keys());
  let orphanCount = 0;
  for (const msgId of allMessageIds) {
    // If this message's placeholder ID isn't a final thread ID, it's orphaned
    if (!finalThreadIds.has(msgId)) {
      await deleteThread(accountId, msgId);
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    console.log(`[imapSync] Cleaned up ${orphanCount} orphaned placeholder threads`);
  }

  console.log(
    `[imapSync] Stored ${storedCount} messages in ${threadGroups.length} threads (found ${totalMessagesFound} on server)`,
  );

  // Only mark sync as complete if messages were stored OR no messages exist on server.
  if (storedCount > 0 || totalMessagesFound === 0) {
    await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);
  } else {
    console.warn(
      `[imapSync] Found ${totalMessagesFound} messages on server but stored 0 — NOT marking sync as complete so it will be retried`,
    );
  }

  onProgress?.({
    phase: "done",
    current: storedCount,
    total: storedCount,
  });

  return { messages: [] };
}

// ---------------------------------------------------------------------------
// Delta sync
// ---------------------------------------------------------------------------

interface FolderStateUpdate {
  state: FolderSyncState;
  /** last_uid may not be held below this. */
  floor: number;
  /** UIDs the server listed and the fetch did not deliver. */
  undeliveredUids: number[];
}

/**
 * Write the folder sync states a delta sync has worked out, once its messages
 * are stored. A message that was fetched but not stored (its thread was skipped
 * for a pending local operation) holds the folder's last_uid just below its UID,
 * so the next delta fetches it again; it never goes below `floor`. A UID the
 * fetch left out holds it the same way, for a few syncs.
 */
async function recordFolderStates(
  accountId: string,
  folderStates: FolderStateUpdate[],
  imapMsgByLocalId: Map<string, ImapMessage>,
  skippedMessageIds: Set<string>,
): Promise<void> {
  const lowestSkippedUid = new Map<string, number>();
  for (const id of skippedMessageIds) {
    const msg = imapMsgByLocalId.get(id);
    if (!msg) continue;
    const lowest = lowestSkippedUid.get(msg.folder);
    if (lowest === undefined || msg.uid < lowest) lowestSkippedUid.set(msg.folder, msg.uid);
  }

  for (const { state, floor, undeliveredUids } of folderStates) {
    const lowestStored = lowestSkippedUid.get(state.folder_path);
    const retry = uidsToRetry(accountId, state.folder_path, undeliveredUids);
    const lowestUndelivered = retry.length > 0 ? Math.min(...retry) : undefined;
    const lowest =
      lowestStored === undefined
        ? lowestUndelivered
        : lowestUndelivered === undefined
          ? lowestStored
          : Math.min(lowestStored, lowestUndelivered);
    let lastUid = state.last_uid;
    if (lowest !== undefined && lowest - 1 < lastUid) {
      lastUid = Math.max(floor, lowest - 1);
      console.warn(
        `[imapSync] Folder ${state.folder_path}: UID ${lowest} was not stored, holding last_uid at ${lastUid} instead of ${state.last_uid} so it is retried`,
      );
    }
    await upsertFolderSyncState({ ...state, last_uid: lastUid });
  }
}

/**
 * Perform delta sync for an IMAP account.
 * Fetches only new messages since the last sync using stored UID state.
 */
export async function imapDeltaSync(accountId: string, daysBack = 365): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  // Get all folders we've synced before
  const syncStates = await getAllFolderSyncStates(accountId);

  // Also check for any new folders
  const allFolders = await imapListFolders(config);
  const syncableFolders = getSyncableFolders(allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);

  const syncStateMap = new Map(syncStates.map((s) => [s.folder_path, s]));

  const allParsed = new Map<string, ParsedMessage>();
  const allThreadable: ThreadableMessage[] = [];
  const allImapMsgs = new Map<string, ImapMessage>();

  // The sync state each folder should end up with. It is written only after
  // the messages are stored: last_uid is a watermark that the next delta
  // starts above, so recording it first turns any failure while storing
  // (a locked database, the app closing) into mail that is never fetched again.
  const folderStates: FolderStateUpdate[] = [];

  // Separate folders into new (no saved state) vs existing (have saved state)
  const newFolders = syncableFolders.filter((f) => !syncStateMap.has(f.raw_path));
  const existingFolders = syncableFolders.filter((f) => syncStateMap.has(f.raw_path));

  // Handle new folders: search for UIDs then fetch in chunks
  let consecutiveFailures = 0;
  const deltaFolderErrors: string[] = [];
  for (const folder of newFolders) {
    // Circuit breaker: skip remaining new folders after too many failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Delta sync circuit breaker: ${consecutiveFailures} consecutive failures, skipping remaining new folders`,
      );
      break;
    }
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);
    try {
      const sinceDate = computeSinceDate(daysBack);
      const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
      consecutiveFailures = 0;

      if (searchResult.uids.length === 0) continue;

      const { messages, lastUid, undeliveredUids } = await fetchMessagesInBatches(
        config,
        folder.raw_path,
        searchResult.uids,
      );

      for (const msg of messages) {
        const { parsed, threadable } = imapMessageToParsedMessage(
          msg,
          accountId,
          folderMapping.labelId,
        );
        allParsed.set(parsed.id, parsed);
        allThreadable.push(threadable);
        allImapMsgs.set(parsed.id, msg);
      }

      folderStates.push({
        state: {
          account_id: accountId,
          folder_path: folder.raw_path,
          uidvalidity: searchResult.folder_status.uidvalidity,
          last_uid: lastUid,
          modseq: null,
          last_sync_at: Math.floor(Date.now() / 1000),
        },
        floor: 0,
        undeliveredUids,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`Delta sync failed for new folder ${folder.path}:`, err);
      deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
    }
  }

  // Batch-check existing folders in a single IMAP connection.
  // Falls back to per-folder checks if the batch command fails.
  if (existingFolders.length > 0) {
    const deltaRequests: DeltaCheckRequest[] = existingFolders.map((folder) => {
      const savedState = syncStateMap.get(folder.raw_path)!;
      return {
        folder: folder.raw_path,
        last_uid: savedState.last_uid,
        uidvalidity: savedState.uidvalidity ?? 0,
      };
    });

    let deltaResultMap: Map<string, DeltaCheckResult>;
    try {
      const deltaResults = await imapDeltaCheck(config, deltaRequests);
      deltaResultMap = new Map(deltaResults.map((r) => [r.folder, r]));
      console.log(`[imapSync] Batch delta check: ${deltaResults.length}/${existingFolders.length} folders checked`);
    } catch (err) {
      // Batch check failed — fall back to per-folder checks
      console.warn(`[imapSync] Batch delta check failed, falling back to per-folder:`, err);
      deltaResultMap = new Map();
      for (const folder of existingFolders) {
        const savedState = syncStateMap.get(folder.raw_path)!;
        try {
          const currentStatus = await imapGetFolderStatus(config, folder.raw_path);
          const uidvalidityChanged =
            savedState.uidvalidity !== null &&
            currentStatus.uidvalidity !== savedState.uidvalidity;

          if (uidvalidityChanged) {
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: [],
              uidvalidity_changed: true,
            });
          } else {
            const newUids = await imapFetchNewUids(config, folder.raw_path, savedState.last_uid);
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: newUids,
              uidvalidity_changed: false,
            });
          }
        } catch (folderErr) {
          console.error(`[imapSync] Per-folder check failed for ${folder.path}:`, folderErr);
        }
      }
    }

    for (const folder of existingFolders) {
      const folderMapping = mapFolderToLabel(folder);
      const savedState = syncStateMap.get(folder.raw_path)!;
      const deltaResult = deltaResultMap.get(folder.raw_path);

      if (!deltaResult) continue;

      try {
        if (deltaResult.uidvalidity_changed) {
          // UIDVALIDITY changed — full resync of this folder
          console.warn(
            `UIDVALIDITY changed for folder ${folder.path} ` +
              `(was ${savedState.uidvalidity}, now ${deltaResult.uidvalidity}). ` +
              `Doing full resync of this folder.`,
          );
          // Everything stored for this folder is now unreachable. A local id
          // is `imap-{accountId}-{folder}-{uid}`, and the UIDs it was built
          // from no longer name the messages they did: the resync writes the
          // same mail under new ids and would leave the old rows sitting
          // beside them as a second copy of the folder that no later sync can
          // reach. They have to go before the new ones are written.
          const orphanedThreadIds = await deleteMessagesInFolder(accountId, folder.raw_path);
          await deleteEmptyThreads(accountId, orphanedThreadIds);

          const sinceDate = computeSinceDate(daysBack);
          const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate);
          if (searchResult.uids.length === 0) continue;

          const { messages, lastUid, undeliveredUids } = await fetchMessagesInBatches(
            config,
            folder.raw_path,
            searchResult.uids,
          );

          for (const msg of messages) {
            const { parsed, threadable } = imapMessageToParsedMessage(
              msg,
              accountId,
              folderMapping.labelId,
            );
            allParsed.set(parsed.id, parsed);
            allThreadable.push(threadable);
            allImapMsgs.set(parsed.id, msg);
          }

          folderStates.push({
            state: {
              account_id: accountId,
              folder_path: folder.raw_path,
              uidvalidity: searchResult.folder_status.uidvalidity,
              last_uid: lastUid,
              modseq: null,
              last_sync_at: Math.floor(Date.now() / 1000),
            },
            floor: 0,
            undeliveredUids,
          });
          continue;
        }

        // Normal delta: fetch the new UIDs returned by delta check
        if (deltaResult.new_uids.length === 0) continue;

        const { messages, lastUid, uidvalidity, undeliveredUids } = await fetchMessagesInBatches(
          config,
          folder.raw_path,
          deltaResult.new_uids,
        );

        for (const msg of messages) {
          const { parsed, threadable } = imapMessageToParsedMessage(
            msg,
            accountId,
            folderMapping.labelId,
          );
          allParsed.set(parsed.id, parsed);
          allThreadable.push(threadable);
          allImapMsgs.set(parsed.id, msg);
        }

        folderStates.push({
          state: {
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity,
            last_uid: Math.max(savedState.last_uid, lastUid),
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
          },
          floor: savedState.last_uid,
          undeliveredUids,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
        console.error(`Delta sync failed for folder ${folder.path}:`, err);
        deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      }
    }
  }

  // If no new messages found and every folder errored, propagate the error
  if (allThreadable.length === 0 && deltaFolderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${deltaFolderErrors[0]}`);
  }

  if (allThreadable.length === 0) {
    await recordFolderStates(accountId, folderStates, allImapMsgs, new Set());
    return { messages: [] };
  }

  // Build RFC Message-ID → labels map for cross-folder label merging
  const labelsByRfcId = new Map<string, Set<string>>();
  for (const threadable of allThreadable) {
    const parsed = allParsed.get(threadable.id);
    if (!parsed) continue;
    let labels = labelsByRfcId.get(threadable.messageId);
    if (!labels) {
      labels = new Set();
      labelsByRfcId.set(threadable.messageId, labels);
    }
    for (const lid of parsed.labelIds) {
      labels.add(lid);
    }
  }

  // Thread the new messages
  const threadGroups = buildThreads(allThreadable);

  // Store in DB
  const { storedMessages, skippedMessageIds } = await storeThreadsAndMessages(
    accountId,
    threadGroups,
    allParsed,
    allImapMsgs,
    labelsByRfcId,
  );

  // Only now is it safe to say these UIDs are synced
  await recordFolderStates(accountId, folderStates, allImapMsgs, skippedMessageIds);

  // Update sync state timestamp
  await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);

  return { messages: storedMessages };
}
