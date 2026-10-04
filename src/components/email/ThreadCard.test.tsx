import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ThreadCard } from "./ThreadCard";
import type { Thread } from "@/stores/threadStore";
import { runSwipeAction } from "@/services/swipeActions";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

const storeState = vi.hoisted(() => ({ selectedThreadIds: new Set<string>() }));
const uiState = vi.hoisted(() => ({
  emailDensity: "default",
  swipeLeftAction: "trash",
  swipeRightAction: "toggleRead",
}));
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

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) => selector(uiState),
}));

vi.mock("@/services/swipeActions", () => ({ runSwipeAction: vi.fn() }));
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
    uiState.swipeLeftAction = "trash";
    uiState.swipeRightAction = "toggleRead";
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
    const release = () => act(() => void vi.advanceTimersByTime(200));

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows the action field under the card while swiping", () => {
      const { container } = render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
      swipe(container, 100);
      expect(screen.getByTestId("swipe-field")).toHaveTextContent("Delete");
      expect(container.querySelector("button")!.style.transform).toBe("translateX(-100px)");
    });

    it("runs the left action when released past the threshold", () => {
      const thread = makeThread();
      const { container } = render(<ThreadCard thread={thread} isSelected={false} onClick={onClick} />);
      swipe(container, 200);
      release();
      expect(runSwipeAction).toHaveBeenCalledWith("trash", thread);
    });

    it("runs the right action on a swipe to the right", () => {
      const thread = makeThread();
      const { container } = render(<ThreadCard thread={thread} isSelected={false} onClick={onClick} />);
      swipe(container, -200);
      release();
      expect(runSwipeAction).toHaveBeenCalledWith("toggleRead", thread);
    });

    it("does nothing below the threshold", () => {
      const { container } = render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
      swipe(container, 100);
      release();
      expect(runSwipeAction).not.toHaveBeenCalled();
      expect(container.querySelector("button")!.style.transform).toBe("");
    });

    it("stays off during a multi-selection", () => {
      storeState.selectedThreadIds = new Set(["t1", "t2"]);
      const { container } = render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
      swipe(container, 300);
      release();
      expect(screen.queryByTestId("swipe-field")).toBeNull();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("does not move toward a direction set to Off", () => {
      uiState.swipeLeftAction = "none";
      const { container } = render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
      swipe(container, 300);
      release();
      expect(screen.queryByTestId("swipe-field")).toBeNull();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });

    it("opens the snooze dialog instead of running snooze directly", () => {
      uiState.swipeLeftAction = "snooze";
      const { container } = render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
      swipe(container, 300);
      release();
      expect(screen.getByTestId("snooze-dialog")).toBeInTheDocument();
      expect(runSwipeAction).not.toHaveBeenCalled();
    });
  });
});
