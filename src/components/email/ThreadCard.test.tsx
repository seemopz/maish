import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ThreadCard } from "./ThreadCard";
import { SWIPE_IDLE_MS } from "@/hooks/useSwipeGesture";
import type { Thread } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { runSwipeAction } from "@/services/swipeActions";
import { logToFile } from "@/services/logFile";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

const storeState = vi.hoisted(() => ({ selectedThreadIds: new Set<string>() }));
const removeThread = vi.hoisted(() => vi.fn());

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedThreadIds: storeState.selectedThreadIds,
        toggleThreadSelection: vi.fn(),
        selectThreadRange: vi.fn(),
        removeThread,
      }),
    { getState: () => ({ selectedThreadIds: storeState.selectedThreadIds }) },
  ),
}));

vi.mock("@/services/db/settings", () => ({ setSetting: vi.fn(() => Promise.resolve()) }));

vi.mock("@/services/swipeActions", () => ({ runSwipeAction: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));
vi.mock("@/services/snooze/snoozeManager", () => ({ snoozeThread: vi.fn() }));
vi.mock("./SnoozeDialog", () => ({
  SnoozeDialog: () => <div data-testid="snooze-dialog" />,
}));

vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    accountId: "a1",
    subject: "Test subject",
    snippet: "Test snippet",
    lastMessageAt: Date.now(),
    messageCount: 1,
    isRead: false,
    isStarred: false,
    isPinned: false,
    isMuted: false,
    hasAttachments: false,
    labelIds: ["INBOX"],
    fromName: "Alice",
    fromAddress: "alice@example.com",
    ...overrides,
  };
}

describe("ThreadCard", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.selectedThreadIds = new Set();
    useUIStore.setState({
      emailDensity: "default",
      swipeLeftActions: ["trash", "archive"],
      swipeRightActions: ["toggleRead", "snooze"],
      openSwipe: null,
    });
  });

  it("renders sender name and subject", () => {
    render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Test subject")).toBeInTheDocument();
  });

  it("applies red background for spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["SPAM"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-danger/5");
  });

  it("does not apply red background for non-spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).not.toContain("bg-danger");
  });

  it("applies red background for spam even when thread has other labels", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX", "SPAM", "IMPORTANT"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-danger/5");
  });
  describe("trackpad swipe", () => {
    function swipe(container: HTMLElement, deltaX: number) {
      const wrapper = container.firstElementChild as HTMLElement;
      Object.defineProperty(wrapper, "offsetWidth", { value: 400, configurable: true });
      for (const dx of [deltaX / 2, deltaX / 2]) {
        act(() => {
          wrapper.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, cancelable: true, bubbles: true }));
        });
      }
    }
    const release = () => act(() => void vi.advanceTimersByTime(SWIPE_IDLE_MS + 1));
    const settle = () => act(() => void vi.advanceTimersByTime(400));
    const card = (container: HTMLElement) => container.querySelector("button[aria-selected]") as HTMLElement;
    const renderCard = (thread = makeThread()) =>
      render(<ThreadCard thread={thread} isSelected={false} onClick={onClick} />);

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.advanceTimersByTime(SWIPE_IDLE_MS + 1); // ends the module-wide swipe lock
      vi.useRealTimers();
    });

    it("shows the side's buttons under the card while swiping", () => {
      const { container } = renderCard();
      swipe(container, 100);
      const field = screen.getByTestId("swipe-field");
      expect(field).toHaveTextContent("Delete");
      expect(field).toHaveTextContent("Archive");
      expect(card(container).style.transform).toBe("translateX(-100px)");
    });

    it("a light swipe opens the buttons and runs nothing", () => {
      const { container } = renderCard();
      swipe(container, 90);
      release();
      expect(runSwipeAction).not.toHaveBeenCalled();
      expect(useUIStore.getState().openSwipe).toEqual({ threadId: "t1", side: "left" });
      // Rests open at two button widths; the buttons stay.
      expect(card(container).style.transform).toBe("translateX(-128px)");
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("a click on an opened button runs it and closes the card", () => {
      const thread = makeThread();
      const { container } = renderCard(thread);
      swipe(container, 90);
      release();
      act(() => screen.getByRole("button", { name: "Archive" }).click());
      expect(runSwipeAction).toHaveBeenCalledWith("archive", thread);
      expect(useUIStore.getState().openSwipe).toBeNull();
      expect(onClick).not.toHaveBeenCalled();
    });

    it("a full swipe runs the first button and does not open the card", () => {
      const thread = makeThread();
      const { container } = renderCard(thread);
      swipe(container, 220);
      release();
      expect(runSwipeAction).toHaveBeenCalledTimes(1);
      expect(runSwipeAction).toHaveBeenCalledWith("trash", thread);
      expect(useUIStore.getState().openSwipe).toBeNull();
    });

    it("runs the first right button on a full swipe to the right", () => {
      const thread = makeThread();
      const { container } = renderCard(thread);
      swipe(container, -220);
      release();
      expect(runSwipeAction).toHaveBeenCalledWith("toggleRead", thread);
    });

    it("a momentum tail after a full swipe does nothing more", () => {
      const { container } = renderCard();
      const wrapper = container.firstElementChild as HTMLElement;
      Object.defineProperty(wrapper, "offsetWidth", { value: 400, configurable: true });
      const flick = [40, 80, 120, 160, 200];
      for (let v = 200 * 0.85; v >= 1; v *= 0.85) flick.push(Math.round(v));
      for (const dx of flick) {
        act(() => void wrapper.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, cancelable: true, bubbles: true })));
      }
      release();
      expect(runSwipeAction).toHaveBeenCalledTimes(1);
      expect(useUIStore.getState().openSwipe).toBeNull();
    });

    it("logs a failing swipe action instead of leaving an unhandled rejection", async () => {
      vi.mocked(runSwipeAction).mockRejectedValueOnce(new Error("boom"));
      const { container } = renderCard();
      swipe(container, 220);
      release();
      await act(async () => {});
      expect(logToFile).toHaveBeenCalledWith("error", expect.stringContaining("boom"));
    });

    it("snaps back below the light threshold", () => {
      const { container } = renderCard();
      swipe(container, 40);
      release();
      expect(runSwipeAction).not.toHaveBeenCalled();
      expect(useUIStore.getState().openSwipe).toBeNull();
      settle();
      expect(card(container).style.transform).toBe("");
    });

    it("eases back after a release instead of snapping, and keeps the field for the ease", () => {
      const { container } = renderCard();
      swipe(container, 40);
      expect(card(container).style.transition).toBe("");
      const before = screen.getByTestId("swipe-field");
      release();
      expect(card(container).style.transform).toBe("translateX(0px)");
      expect(card(container).style.transition).toContain("transform 300ms");
      const field = screen.getByTestId("swipe-field");
      // The same node, or the width change has nothing to animate from.
      expect(field).toBe(before);
      expect(field.style.width).toBe("0px");
      expect(field.style.transition).toContain("width 300ms");
      settle();
      expect(card(container).style.transform).toBe("");
      expect(screen.queryByTestId("swipe-field")).toBeNull();
    });

    it("closes on a tap on the card, without opening the thread", () => {
      const { container } = renderCard();
      swipe(container, 90);
      release();
      act(() => card(container).click());
      expect(onClick).not.toHaveBeenCalled();
      expect(useUIStore.getState().openSwipe).toBeNull();
    });

    it("closes on a click elsewhere, on Escape, and when the list scrolls", () => {
      const { container } = renderCard();
      const reopen = () => {
        swipe(container, 90);
        release();
        expect(useUIStore.getState().openSwipe).not.toBeNull();
      };
      reopen();
      act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      expect(useUIStore.getState().openSwipe).toBeNull();
      reopen();
      act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(useUIStore.getState().openSwipe).toBeNull();
      reopen();
      act(() => void document.body.dispatchEvent(new Event("scroll")));
      expect(useUIStore.getState().openSwipe).toBeNull();
    });

    it("does not close on the scroll the momentum tail of the opening swipe causes", () => {
      const { container } = renderCard();
      const wrapper = container.firstElementChild as HTMLElement;
      Object.defineProperty(wrapper, "offsetWidth", { value: 400, configurable: true });
      for (const dx of [12, 18, 16, 12, 8, 5, 3, 2, 1, 1]) {
        act(() => void wrapper.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, cancelable: true, bubbles: true })));
      }
      expect(useUIStore.getState().openSwipe).not.toBeNull();
      act(() => void document.body.dispatchEvent(new Event("scroll"))); // still in the tail
      expect(useUIStore.getState().openSwipe).not.toBeNull();
      release();
      act(() => void document.body.dispatchEvent(new Event("scroll"))); // the user scrolls on
      expect(useUIStore.getState().openSwipe).toBeNull();
    });

    it("keeps one card open: opening another closes this one", () => {
      const { container } = renderCard();
      swipe(container, 90);
      release();
      expect(card(container).style.transform).toBe("translateX(-128px)");
      act(() => useUIStore.getState().setOpenSwipe({ threadId: "other", side: "right" }));
      expect(card(container).style.transform).toBe("translateX(0px)");
      settle();
      expect(card(container).style.transform).toBe("");
    });

    it("a swipe back closes an open card", () => {
      const { container } = renderCard();
      swipe(container, 90);
      release();
      swipe(container, -100);
      release();
      expect(useUIStore.getState().openSwipe).toBeNull();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("stays off during a multi-selection", () => {
      storeState.selectedThreadIds = new Set(["t1", "t2"]);
      const { container } = renderCard();
      swipe(container, 300);
      release();
      expect(screen.queryByTestId("swipe-field")).toBeNull();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("does not move toward a side without buttons", () => {
      useUIStore.setState({ swipeLeftActions: [] });
      const { container } = renderCard();
      swipe(container, 300);
      release();
      expect(screen.queryByTestId("swipe-field")).toBeNull();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("opens the snooze dialog instead of running snooze directly", () => {
      useUIStore.setState({ swipeLeftActions: ["snooze"] });
      const { container } = renderCard();
      swipe(container, 300);
      release();
      expect(screen.getByTestId("snooze-dialog")).toBeInTheDocument();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("opens the snooze dialog from its button", () => {
      const { container } = renderCard();
      swipe(container, -90);
      release();
      act(() => screen.getByRole("button", { name: /snooze/i }).click());
      expect(screen.getByTestId("snooze-dialog")).toBeInTheDocument();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });
  });
});
