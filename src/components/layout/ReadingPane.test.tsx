import { render, screen, fireEvent } from "@testing-library/react";
import { ReadingPane } from "./ReadingPane";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { SWIPE_IDLE_MS } from "@/hooks/useSwipeGesture";

const navigateToThread = vi.fn();
let selectedId: string | null = "b";

vi.mock("@/services/db/settings", () => ({ setSetting: vi.fn(() => Promise.resolve()) }));
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

describe("ReadingPane zoom", () => {
  const pane = () => screen.getByTestId("thread-view").parentElement!.parentElement!;

  beforeEach(() => {
    selectedId = "b";
    const threads = ["a", "b", "c"].map(thread);
    useThreadStore.setState({ threads, threadMap: new Map(threads.map((t) => [t.id, t])) });
    useUIStore.setState({ mailZoom: 1 });
  });

  it("zooms in on a pinch (ctrl+wheel, fingers apart) and keeps the page from zooming", () => {
    render(<ReadingPane />);
    const notCancelled = fireEvent.wheel(pane(), { ctrlKey: true, deltaY: -10 });
    expect(useUIStore.getState().mailZoom).toBeGreaterThan(1);
    expect(notCancelled).toBe(false);
  });

  it("zooms out on a pinch the other way", () => {
    render(<ReadingPane />);
    fireEvent.wheel(pane(), { ctrlKey: true, deltaY: 10 });
    expect(useUIStore.getState().mailZoom).toBeLessThan(1);
  });

  it("follows a slow pinch made of fractions of a pixel", () => {
    render(<ReadingPane />);
    for (let i = 0; i < 50; i++) fireEvent.wheel(pane(), { ctrlKey: true, deltaY: -0.4 });
    expect(useUIStore.getState().mailZoom).toBeGreaterThan(1.1);
  });

  it("leaves a plain wheel alone", () => {
    render(<ReadingPane />);
    fireEvent.wheel(pane(), { deltaY: -10 });
    expect(useUIStore.getState().mailZoom).toBe(1);
  });

  it("steps with Ctrl+Plus and Ctrl+Minus and resets with Ctrl+0", () => {
    render(<ReadingPane />);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(useUIStore.getState().mailZoom).toBe(1.1);
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(useUIStore.getState().mailZoom).toBe(1.2);
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(useUIStore.getState().mailZoom).toBe(1);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(useUIStore.getState().mailZoom).toBe(1);
  });

  it("ignores the keys without Ctrl and while no mail is open", () => {
    render(<ReadingPane />);
    fireEvent.keyDown(window, { key: "+" });
    expect(useUIStore.getState().mailZoom).toBe(1);
  });

  it("does nothing while no mail is open", () => {
    selectedId = null;
    render(<ReadingPane />);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(useUIStore.getState().mailZoom).toBe(1);
  });
});
