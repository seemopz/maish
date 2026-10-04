import { render, fireEvent } from "@testing-library/react";
import { useMouseNavigation } from "./useMouseNavigation";
import { useThreadStore } from "@/stores/threadStore";

const navigateToThread = vi.fn();
const back = vi.fn();
const forward = vi.fn();
let selectedId: string | null = "b";

vi.mock("@/router", () => ({ router: { history: { back: () => back(), forward: () => forward() } } }));
vi.mock("@/router/navigate", () => ({
  navigateToThread: (id: string) => navigateToThread(id),
  getSelectedThreadId: () => selectedId,
}));

function Harness() {
  useMouseNavigation();
  return <input data-testid="field" />;
}

const thread = (id: string) => ({ id }) as never;

describe("useMouseNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedId = "b";
    const threads = ["a", "b", "c"].map(thread);
    useThreadStore.setState({ threads, threadMap: new Map(threads.map((t) => [t.id, t])) });
  });

  it("opens the previous mail on the back button", () => {
    render(<Harness />);
    fireEvent.mouseUp(document.body, { button: 3 });
    expect(navigateToThread).toHaveBeenCalledWith("a");
  });

  it("opens the next mail on the forward button", () => {
    render(<Harness />);
    fireEvent.mouseUp(document.body, { button: 4 });
    expect(navigateToThread).toHaveBeenCalledWith("c");
  });

  it("does nothing past either end of the list", () => {
    render(<Harness />);
    selectedId = "a";
    fireEvent.mouseUp(document.body, { button: 3 });
    selectedId = "c";
    fireEvent.mouseUp(document.body, { button: 4 });
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("walks the router history when no mail is open", () => {
    selectedId = null;
    render(<Harness />);
    fireEvent.mouseUp(document.body, { button: 3 });
    expect(back).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(document.body, { button: 4 });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("ignores the other buttons", () => {
    render(<Harness />);
    fireEvent.mouseUp(document.body, { button: 0 });
    fireEvent.mouseUp(document.body, { button: 1 });
    fireEvent.mouseUp(document.body, { button: 2 });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("stays put while a field has focus, so an unsent reply is not lost", () => {
    const { getByTestId } = render(<Harness />);
    getByTestId("field").focus();
    fireEvent.mouseUp(document.body, { button: 3 });
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("keeps the webview from navigating on the press", () => {
    render(<Harness />);
    expect(fireEvent.mouseDown(document.body, { button: 3 })).toBe(false);
    expect(fireEvent.mouseDown(document.body, { button: 0 })).toBe(true);
  });
});
