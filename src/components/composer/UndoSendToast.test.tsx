import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { UndoSendToast } from "./UndoSendToast";
import { useComposerStore } from "@/stores/composerStore";

/**
 * The composer is already closed and emptied by the time this toast appears,
 * so "Undo" used to cancel the send and drop the mail with it — the text was
 * gone and there was nothing to go back to.
 */
describe("UndoSendToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useComposerStore.setState({
      isOpen: false,
      undoSendVisible: true,
      undoSendTimer: null,
      pendingSend: null,
      session: 0,
    });
  });

  it("runs its progress bar for the configured undo window", () => {
    useComposerStore.setState({
      pendingSend: {
        mode: "new", to: [], cc: [], bcc: [], subject: "", bodyHtml: "", threadId: null,
        inReplyToMessageId: null, references: null, draftId: null, fromEmail: null, attachments: [],
        delaySeconds: 10,
      },
    });

    const { container } = render(<UndoSendToast />);

    expect(container.ownerDocument.querySelector("[style*='countdownBar']")!.getAttribute("style")).toContain("10s");
  });

  it("reopens the composer with the mail that was about to go out", () => {
    const timer = setTimeout(() => { throw new Error("send must not run"); }, 5000);
    useComposerStore.setState({
      undoSendTimer: timer,
      pendingSend: {
        mode: "reply",
        to: ["bob@example.com"],
        cc: ["carol@example.com"],
        bcc: [],
        subject: "Half-written",
        bodyHtml: "<p>text that must not be lost</p>",
        threadId: "t1",
        inReplyToMessageId: "m1",
        draftId: "d1",
        fromEmail: "simon@hochreiner.xyz",
        attachments: [],
      },
    });

    const { getByText } = render(<UndoSendToast />);
    act(() => {
      getByText("Undo").click();
    });

    const state = useComposerStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.to).toEqual(["bob@example.com"]);
    expect(state.cc).toEqual(["carol@example.com"]);
    expect(state.subject).toBe("Half-written");
    expect(state.bodyHtml).toBe("<p>text that must not be lost</p>");
    expect(state.threadId).toBe("t1");
    expect(state.draftId).toBe("d1");
    expect(state.fromEmail).toBe("simon@hochreiner.xyz");
    expect(state.undoSendVisible).toBe(false);
    expect(state.undoSendTimer).toBeNull();
    expect(state.pendingSend).toBeNull();

    clearTimeout(timer);
  });

  it("stops the scheduled send", () => {
    const send = vi.fn();
    const timer = setTimeout(send, 0);
    useComposerStore.setState({ undoSendTimer: timer, pendingSend: null });

    const { getByText } = render(<UndoSendToast />);
    act(() => {
      getByText("Undo").click();
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(send).not.toHaveBeenCalled();
        resolve();
      }, 10);
    });
  });
});
