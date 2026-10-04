import { render, screen, fireEvent } from "@testing-library/react";
import { ReadingPane } from "./ReadingPane";
import { useThreadStore } from "@/stores/threadStore";
import { SWIPE_IDLE_MS } from "@/hooks/useSwipeGesture";

const navigateToThread = vi.fn();
let selectedId: string | null = "b";

vi.mock("@/router/navigate", () => ({ navigateToThread: (id: string) => navigateToThread(id) }));
vi.mock("@/hooks/useRouteNavigation", () => ({ useSelectedThreadId: () => selectedId }));
vi.mock("../email/ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));

const thread = (id: string) => ({ id }) as never;

function swipe(pane: HTMLElement, deltaX: number) {
  Object.defineProperty(pane, "offsetWidth", { value: 100, configurable: true });
  // Fingers moving left make deltaX positive; 50 of 100 px clears the threshold.
  fireEvent.wheel(pane, { deltaX, deltaY: 0 });
  vi.advanceTimersByTime(SWIPE_IDLE_MS + 1);
}

describe("ReadingPane swipe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    navigateToThread.mockClear();
    selectedId = "b";
    const threads = ["a", "b", "c"].map(thread);
    useThreadStore.setState({ threads, threadMap: new Map(threads.map((t) => [t.id, t])) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the next mail on a swipe to the left", () => {
    render(<ReadingPane />);
    swipe(screen.getByTestId("thread-view").parentElement!.parentElement!, 50);
    expect(navigateToThread).toHaveBeenCalledWith("c");
  });

  it("opens the previous mail on a swipe to the right", () => {
    render(<ReadingPane />);
    swipe(screen.getByTestId("thread-view").parentElement!.parentElement!, -50);
    expect(navigateToThread).toHaveBeenCalledWith("a");
  });

  it("does nothing past the end of the list", () => {
    selectedId = "c";
    render(<ReadingPane />);
    swipe(screen.getByTestId("thread-view").parentElement!.parentElement!, 50);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("does nothing before the start of the list", () => {
    selectedId = "a";
    render(<ReadingPane />);
    swipe(screen.getByTestId("thread-view").parentElement!.parentElement!, -50);
    expect(navigateToThread).not.toHaveBeenCalled();
  });
  it("stays put while a field has focus, so an unsent reply is not lost", () => {
    const { container } = render(<ReadingPane />);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    swipe(screen.getByTestId("thread-view").parentElement!.parentElement!, 50);
    expect(navigateToThread).not.toHaveBeenCalled();
  });
});
