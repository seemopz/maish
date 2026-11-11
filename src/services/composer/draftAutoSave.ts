import { useComposerStore } from "@/stores/composerStore";
import { createDraft as createDraftAction, updateDraft as updateDraftAction } from "@/services/emailActions";
import { buildRawEmail } from "@/utils/emailBuilder";
import { useAccountStore } from "@/stores/accountStore";
import { logToFile } from "@/services/logFile";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let currentAccountId: string | null = null;
// Saves run one after another: two overlapping saves both saw draftId null and created two drafts.
let saveChain: Promise<void> = Promise.resolve();

const DEBOUNCE_MS = 3000;

async function saveDraft(): Promise<void> {
  const state = useComposerStore.getState();
  // Capture the accountId at save time to avoid mismatch if user switches accounts during debounce
  const accountId = currentAccountId;
  if (!state.isOpen || !accountId) return;

  const accounts = useAccountStore.getState().accounts;
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;

  // Don't save empty drafts
  if (!state.bodyHtml && !state.subject && state.to.length === 0) return;

  state.setIsSaving(true);

  try {
    const raw = buildRawEmail({
      from: state.fromEmail ?? account.email,
      to: state.to.length > 0 ? state.to : [""],
      cc: state.cc.length > 0 ? state.cc : undefined,
      bcc: state.bcc.length > 0 ? state.bcc : undefined,
      subject: state.subject,
      htmlBody: state.bodyHtml,
      inReplyTo: state.inReplyToMessageId ?? undefined,
      references: state.references ?? undefined,
      threadId: state.threadId ?? undefined,
      attachments: state.attachments.length > 0
        ? state.attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            content: a.content,
          }))
        : undefined,
    });

    const result = state.draftId
      ? await updateDraftAction(accountId, state.draftId, raw, state.threadId ?? undefined)
      : await createDraftAction(accountId, raw, state.threadId ?? undefined);
    // A permanent error is returned, not thrown.
    if (!result.success) throw new Error(result.error ?? "unknown error");
    // An IMAP update replaces the copy, so its id changes too. A compose session opened
    // during the save must not inherit this draft.
    if (
      useComposerStore.getState().session === state.session &&
      result.data && typeof result.data === "object" && "draftId" in result.data
    ) {
      state.setDraftId((result.data as { draftId: string }).draftId);
    }

    state.setLastSavedAt(Date.now());
  } catch (err) {
    logToFile("error", `Failed to auto-save draft: ${String(err)}`);
  } finally {
    state.setIsSaving(false);
  }
}

function queueSave(): Promise<void> {
  saveChain = saveChain.then(saveDraft);
  return saveChain;
}

function scheduleSave(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void queueSave();
  }, DEBOUNCE_MS);
}

/**
 * Save edits still waiting for the debounce now, and wait for any save in
 * flight. Call before closing the composer, otherwise the last 3 s are lost.
 */
export function flushAutoSave(): Promise<void> {
  if (!debounceTimer) return saveChain;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  return queueSave();
}

/**
 * Start watching composerStore changes and auto-saving drafts.
 */
export function startAutoSave(accountId: string): void {
  stopAutoSave();
  currentAccountId = accountId;

  // Subscribe to store changes — trigger debounced save on any field change
  unsubscribe = useComposerStore.subscribe(
    (state, prevState) => {
      if (!state.isOpen) return;
      // Only save when content-relevant fields change
      if (
        state.bodyHtml !== prevState.bodyHtml ||
        state.subject !== prevState.subject ||
        state.to !== prevState.to ||
        state.cc !== prevState.cc ||
        state.bcc !== prevState.bcc ||
        state.attachments !== prevState.attachments
      ) {
        scheduleSave();
      }
    },
  );
}

/**
 * Stop auto-saving and clean up.
 */
export function stopAutoSave(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  currentAccountId = null;
}
