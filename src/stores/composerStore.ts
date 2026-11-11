import { create } from "zustand";

export type ComposerMode = "new" | "reply" | "replyAll" | "forward";
export type ComposerViewMode = "modal" | "fullpage";

export interface ComposerAttachment {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  size: number;
  content: string; // base64
}

/**
 * A copy of everything the user composed, kept for the length of the undo
 * window. handleSend closes the composer as soon as the send is scheduled, so
 * the store has already been emptied by the time the toast is on screen — this
 * is the only remaining copy, and without it "Undo" threw the mail away
 * instead of handing it back.
 */
export interface PendingSend {
  mode: ComposerMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  references: string | null;
  draftId: string | null;
  fromEmail: string | null;
  attachments: ComposerAttachment[];
  /** Length of the undo window, for the toast's progress bar. */
  delaySeconds?: number;
}

export interface ComposerState {
  isOpen: boolean;
  /**
   * Incremented by openComposer. The editor is created once, when the app
   * starts and the composer is still closed, so it cannot take its content
   * from the initial state; it has to be filled when a compose session
   * begins. isOpen alone does not mark that, because opening a composer that
   * is already open — a reply while a draft is up, a mailto: deep link —
   * leaves it true throughout.
   */
  session: number;
  mode: ComposerMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  /** The RFC 5322 Message-ID (`<…@…>`) of the mail answered, not Maish's row id. */
  inReplyToMessageId: string | null;
  references: string | null;
  showCcBcc: boolean;
  draftId: string | null;
  undoSendTimer: ReturnType<typeof setTimeout> | null;
  undoSendVisible: boolean;
  pendingSend: PendingSend | null;
  attachments: ComposerAttachment[];
  lastSavedAt: number | null;
  isSaving: boolean;
  fromEmail: string | null;
  viewMode: ComposerViewMode;
  signatureHtml: string;
  signatureId: string | null;

  openComposer: (opts?: {
    mode?: ComposerMode;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    bodyHtml?: string;
    threadId?: string | null;
    inReplyToMessageId?: string | null;
    references?: string | null;
    draftId?: string | null;
    fromEmail?: string | null;
    attachments?: ComposerAttachment[];
  }) => void;
  closeComposer: () => void;
  setPendingSend: (pending: PendingSend | null) => void;
  setTo: (to: string[]) => void;
  setCc: (cc: string[]) => void;
  setBcc: (bcc: string[]) => void;
  setSubject: (subject: string) => void;
  setBodyHtml: (bodyHtml: string) => void;
  setShowCcBcc: (show: boolean) => void;
  setDraftId: (id: string | null) => void;
  setUndoSendTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  setUndoSendVisible: (visible: boolean) => void;
  addAttachment: (attachment: ComposerAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setLastSavedAt: (ts: number | null) => void;
  setIsSaving: (saving: boolean) => void;
  setFromEmail: (email: string | null) => void;
  setViewMode: (mode: ComposerViewMode) => void;
  setSignatureHtml: (html: string) => void;
  setSignatureId: (id: string | null) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  isOpen: false,
  session: 0,
  mode: "new",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  bodyHtml: "",
  threadId: null,
  inReplyToMessageId: null,
  references: null,
  showCcBcc: false,
  draftId: null,
  undoSendTimer: null,
  undoSendVisible: false,
  pendingSend: null,
  attachments: [],
  viewMode: "modal",
  fromEmail: null,
  lastSavedAt: null,
  isSaving: false,
  signatureHtml: "",
  signatureId: null,

  openComposer: (opts) =>
    set((state) => ({
      isOpen: true,
      session: state.session + 1,
      mode: opts?.mode ?? "new",
      to: opts?.to ?? [],
      cc: opts?.cc ?? [],
      bcc: opts?.bcc ?? [],
      subject: opts?.subject ?? "",
      bodyHtml: opts?.bodyHtml ?? "",
      threadId: opts?.threadId ?? null,
      inReplyToMessageId: opts?.inReplyToMessageId ?? null,
      references: opts?.references ?? null,
      showCcBcc: (opts?.cc?.length ?? 0) > 0 || (opts?.bcc?.length ?? 0) > 0,
      draftId: opts?.draftId ?? null,
      viewMode: "modal",
      fromEmail: opts?.fromEmail ?? null,
      attachments: opts?.attachments ?? [],
      lastSavedAt: null,
      isSaving: false,
      signatureHtml: "",
      signatureId: null,
    })),
  closeComposer: () =>
    set({
      isOpen: false,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      bodyHtml: "",
      threadId: null,
      inReplyToMessageId: null,
      references: null,
      showCcBcc: false,
      draftId: null,
      viewMode: "modal",
      fromEmail: null,
      attachments: [],
      lastSavedAt: null,
      isSaving: false,
      signatureHtml: "",
      signatureId: null,
    }),
  setPendingSend: (pendingSend) => set({ pendingSend }),
  setTo: (to) => set({ to }),
  setCc: (cc) => set({ cc }),
  setBcc: (bcc) => set({ bcc }),
  setSubject: (subject) => set({ subject }),
  setBodyHtml: (bodyHtml) => set({ bodyHtml }),
  setShowCcBcc: (showCcBcc) => set({ showCcBcc }),
  setDraftId: (draftId) => set({ draftId }),
  setUndoSendTimer: (undoSendTimer) => set({ undoSendTimer }),
  setUndoSendVisible: (undoSendVisible) => set({ undoSendVisible }),
  addAttachment: (attachment) =>
    set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (id) =>
    set((state) => ({
      attachments: state.attachments.filter((a) => a.id !== id),
    })),
  clearAttachments: () => set({ attachments: [] }),
  setLastSavedAt: (lastSavedAt) => set({ lastSavedAt }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setFromEmail: (fromEmail) => set({ fromEmail }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSignatureHtml: (signatureHtml) => set({ signatureHtml }),
  setSignatureId: (signatureId) => set({ signatureId }),
}));
