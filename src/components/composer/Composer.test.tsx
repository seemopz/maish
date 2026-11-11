import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

/**
 * The editor object TipTap would hand back. Only the parts Composer touches
 * are here; the point of the test is the wiring between the store and the
 * editor, not ProseMirror's behaviour.
 */
const setContent = vi.fn();
let editorHtml = "";

const fakeEditor = {
  commands: {
    setContent: (content: string, options?: unknown) => {
      setContent(content, options);
      editorHtml = content;
    },
  },
  chain: () => ({
    focus: () => ({ run: () => true }),
  }),
  getHTML: () => editorHtml,
  isActive: () => false,
  isEmpty: false,
  can: () => ({ chain: () => ({ focus: () => ({ run: () => false }) }) }),
};

vi.mock("@tiptap/react", () => ({
  useEditor: () => fakeEditor,
  EditorContent: () => null,
}));
vi.mock("@tiptap/starter-kit", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-placeholder", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-image", () => ({ default: { configure: () => ({}) } }));

vi.mock("./EditorToolbar", () => ({ EditorToolbar: () => null }));
vi.mock("./AiAssistPanel", () => ({ AiAssistPanel: () => null }));
vi.mock("./AttachmentPicker", () => ({ AttachmentPicker: () => null }));
vi.mock("./ScheduleSendDialog", () => ({ ScheduleSendDialog: () => null }));
vi.mock("./SignatureSelector", () => ({ SignatureSelector: () => null }));
vi.mock("./TemplatePicker", () => ({ TemplatePicker: () => null }));
vi.mock("./FromSelector", () => ({ FromSelector: () => null }));
vi.mock("./AddressInput", () => ({ AddressInput: () => null }));

vi.mock("@/services/emailActions", () => ({
  sendEmail: vi.fn(() => Promise.resolve({ success: true })),
  archiveThread: vi.fn(() => Promise.resolve({ success: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ success: true })),
}));
vi.mock("@/services/db/contacts", () => ({ upsertContact: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/services/db/scheduledEmails", () => ({ insertScheduledEmail: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services/db/signatures", () => ({ getDefaultSignature: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/services/db/sendAsAliases", () => ({
  getAliasesForAccount: vi.fn(() => Promise.resolve([])),
  mapDbAlias: (a: unknown) => a,
}));
vi.mock("@/services/db/templates", () => ({ getTemplatesForAccount: vi.fn(() => Promise.resolve([])) }));
vi.mock("@/services/composer/draftAutoSave", () => ({
  startAutoSave: vi.fn(),
  stopAutoSave: vi.fn(),
  flushAutoSave: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));
const { webviewCtor } = vi.hoisted(() => ({ webviewCtor: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = () => Promise.resolve(null);
    constructor(label: string, opts: unknown) { webviewCtor(label, opts); }
  },
}));
vi.mock("@/utils/emailBuilder", () => ({ buildRawEmail: vi.fn(() => "") }));

import { Composer } from "./Composer";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { sendEmail, deleteDraft } from "@/services/emailActions";
import { getSetting } from "@/services/db/settings";
import { flushAutoSave } from "@/services/composer/draftAutoSave";
import { logToFile } from "@/services/logFile";

/**
 * <Composer /> is mounted unconditionally by App, so useEditor runs once at
 * app start — when the store is still empty. The CSSTransition's
 * unmountOnExit sits on the overlay inside the component, not on the
 * component, so the editor is never rebuilt. Without an explicit push a
 * reply's quote, a forwarded message and a loaded draft all opened into an
 * empty editor, and whatever was typed last stayed behind in it.
 */
describe("Composer editor content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
    useComposerStore.setState({ isOpen: false, session: 0, bodyHtml: "" });
    useAccountStore.setState({
      accounts: [{ id: "acct-1", email: "simon@hochreiner.xyz" }],
      activeAccountId: "acct-1",
    } as never);
  });

  it("puts the reply quote into the editor when the composer opens", () => {
    render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({
        mode: "reply",
        bodyHtml: "<blockquote>the message being answered</blockquote>",
      });
    });

    expect(setContent).toHaveBeenCalledWith(
      "<blockquote>the message being answered</blockquote>",
      expect.objectContaining({ emitUpdate: false }),
    );
  });

  it("clears the editor for a fresh compose after an earlier one", () => {
    render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({ bodyHtml: "<p>first draft</p>" });
    });
    act(() => {
      useComposerStore.getState().closeComposer();
    });
    setContent.mockClear();

    act(() => {
      useComposerStore.getState().openComposer();
    });

    expect(setContent).toHaveBeenCalledWith("", expect.objectContaining({ emitUpdate: false }));
  });

  it("reloads the body when a composer that is already open is reused", () => {
    render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({ bodyHtml: "<p>draft</p>" });
    });
    setContent.mockClear();

    // A mailto: deep link or a reply raised while the composer is up never
    // takes isOpen back to false.
    act(() => {
      useComposerStore.getState().openComposer({ bodyHtml: "<p>a different mail</p>" });
    });

    expect(setContent).toHaveBeenCalledWith(
      "<p>a different mail</p>",
      expect.objectContaining({ emitUpdate: false }),
    );
  });
});

/**
 * handleSend hands the mail to a timer and closes the composer straight away,
 * so the undo window runs with no composer on screen. Two things follow from
 * that, and both used to be wrong.
 */
describe("Composer send guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
    useComposerStore.setState({
      isOpen: false,
      session: 0,
      bodyHtml: "",
      undoSendTimer: null,
      undoSendVisible: false,
      pendingSend: null,
    });
    useAccountStore.setState({
      accounts: [{ id: "acct-1", email: "simon@hochreiner.xyz" }],
      activeAccountId: "acct-1",
    } as never);
  });

  async function clickSend(getByText: (t: string) => HTMLElement) {
    await act(async () => {
      getByText("Send").click();
    });
  }

  it("can send again once the undo window has been cancelled", async () => {
    const { getByText } = render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"] });
    });
    await clickSend(getByText);

    const timer = useComposerStore.getState().undoSendTimer;
    expect(timer).not.toBeNull();

    // What UndoSendToast does: drop the timer, so the callback that used to
    // be the only thing clearing the guard never runs.
    act(() => {
      clearTimeout(timer!);
      useComposerStore.getState().setUndoSendTimer(null);
      useComposerStore.getState().setUndoSendVisible(false);
    });

    // A second attempt must actually schedule a send rather than return
    // silently on a guard nobody reset.
    act(() => {
      useComposerStore.getState().openComposer({ to: ["carol@example.com"] });
    });
    await clickSend(getByText);

    expect(useComposerStore.getState().undoSendTimer).not.toBeNull();
  });

  it("can send a second mail while the first is still in its undo window", async () => {
    const { getByText } = render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"] });
    });
    await clickSend(getByText);
    const first = useComposerStore.getState().undoSendTimer;

    act(() => {
      useComposerStore.getState().openComposer({ to: ["carol@example.com"] });
    });
    await clickSend(getByText);

    expect(useComposerStore.getState().undoSendTimer).not.toBe(first);
    expect(useComposerStore.getState().undoSendTimer).not.toBeNull();
  });

  it("keeps the composed mail so undo can put it back", async () => {
    const { getByText } = render(<Composer />);

    act(() => {
      useComposerStore.getState().openComposer({
        to: ["bob@example.com"],
        subject: "Half-written",
        bodyHtml: "<p>text that must not be lost</p>",
      });
    });
    await clickSend(getByText);

    // closeComposer has already emptied the store by now, so the snapshot is
    // the only remaining copy of what the user wrote.
    const pending = useComposerStore.getState().pendingSend;
    expect(pending).not.toBeNull();
    expect(pending!.to).toEqual(["bob@example.com"]);
    expect(pending!.subject).toBe("Half-written");
    expect(pending!.bodyHtml).toContain("text that must not be lost");
  });
});

/**
 * A permanent send error comes back as `{ success: false }`, not as a throw.
 * The timer used to ignore it, delete the draft and drop the snapshot, so the
 * mail was gone without a trace.
 */
describe("Composer failed send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
    vi.mocked(getSetting).mockResolvedValue("0");
    useComposerStore.setState({
      isOpen: false,
      session: 0,
      bodyHtml: "",
      undoSendTimer: null,
      undoSendVisible: false,
      pendingSend: null,
    });
    useAccountStore.setState({
      accounts: [{ id: "acct-1", email: "simon@hochreiner.xyz" }],
      activeAccountId: "acct-1",
    } as never);
  });

  afterEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  async function sendAndWait(getByText: (t: string) => HTMLElement) {
    await act(async () => {
      getByText("Send").click();
    });
    // pendingSend is set before the timer fires and cleared as its last step.
    await act(async () => {
      await vi.waitFor(() => {
        expect(sendEmail).toHaveBeenCalled();
        expect(useComposerStore.getState().pendingSend).toBeNull();
      });
    });
  }

  it("keeps the draft and hands the mail back when the send fails", async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false, error: "550 rejected" });
    const { getByText } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({
        to: ["bob@example.com"],
        subject: "Important",
        bodyHtml: "<p>must not be lost</p>",
        draftId: "d1",
      });
    });

    await sendAndWait(getByText);

    expect(deleteDraft).not.toHaveBeenCalled();
    const state = useComposerStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.to).toEqual(["bob@example.com"]);
    expect(state.subject).toBe("Important");
    expect(state.draftId).toBe("d1");
    expect(state.pendingSend).toBeNull();
    expect(state.undoSendTimer).toBeNull();
    expect(logToFile).toHaveBeenCalledWith("error", expect.stringContaining("550 rejected"));
  });

  it("hands the mail back when the send throws", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("db locked"));
    const { getByText } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"], subject: "Important" });
    });

    await sendAndWait(getByText);

    expect(useComposerStore.getState().isOpen).toBe(true);
    expect(useComposerStore.getState().subject).toBe("Important");
  });

  it("deletes the draft once the send went through", async () => {
    const { getByText } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"], draftId: "d1" });
    });

    await sendAndWait(getByText);

    expect(deleteDraft).toHaveBeenCalledWith("acct-1", "d1");
    expect(useComposerStore.getState().isOpen).toBe(false);
  });
});

describe("Composer close and pop-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
    useComposerStore.setState({ isOpen: false, session: 0, bodyHtml: "", attachments: [] });
    useAccountStore.setState({
      accounts: [
        { id: "acct-1", email: "simon@hochreiner.xyz" },
        { id: "acct-2", email: "other@example.com" },
      ],
      activeAccountId: "acct-2",
    } as never);
  });

  it("saves the last edits before the close button closes the composer", async () => {
    const { getByLabelText } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"] });
    });

    await act(async () => {
      getByLabelText("Close").click();
    });

    expect(flushAutoSave).toHaveBeenCalled();
    expect(useComposerStore.getState().isOpen).toBe(false);
  });

  // setAccounts without an id made accounts[0] active, so a reply from account B went out via A.
  it("tells the pop-out window which account is writing", async () => {
    const { getByTitle } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({ to: ["bob@example.com"] });
    });

    await act(async () => {
      getByTitle("Open in new window").click();
    });

    // The handler imports the window module first; wait for it so it cannot leak into the next test.
    await vi.waitFor(() => expect(webviewCtor).toHaveBeenCalledTimes(1));
    const url = (webviewCtor.mock.calls[0][1] as { url: string }).url;
    expect(new URLSearchParams(url.split("?")[1]).get("accountId")).toBe("acct-2");
  });

  it("does not pop out a mail whose attachments the window cannot take along", async () => {
    const { getByLabelText } = render(<Composer />);
    act(() => {
      useComposerStore.getState().openComposer({
        to: ["bob@example.com"],
        attachments: [{ id: "a1", file: new File(["x"], "x.txt"), filename: "x.txt", mimeType: "text/plain", size: 1, content: "eA==" }],
      });
    });

    const button = getByLabelText("Open in new window") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(button.disabled).toBe(true);
    expect(webviewCtor).not.toHaveBeenCalled();
  });
});
