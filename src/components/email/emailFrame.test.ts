// Tests for public/emailFrame.js — the bootstrap that runs inside the sandboxed
// email body frame. It lives under public/ because it must be served from the
// app's own origin, so the test loads it from disk and runs it against jsdom.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FRAME_SCRIPT = readFileSync(
  resolve(__dirname, "../../../public/emailFrame.js"),
  "utf-8",
);

function runFrameScript() {
  new Function(FRAME_SCRIPT).call(window);
}

describe("emailFrame bootstrap", () => {
  let posted: unknown[];
  let listeners: Parameters<Document["addEventListener"]>[];
  let windowListeners: Parameters<Window["addEventListener"]>[];

  beforeEach(() => {
    posted = [];
    // The script listens on `document`, which outlives a test; take its listeners off again.
    listeners = [];
    windowListeners = [];
    const add = document.addEventListener.bind(document);
    const addWindow = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((...args: Parameters<typeof addWindow>) => {
      windowListeners.push(args);
      addWindow(...args);
    });
    vi.spyOn(document, "addEventListener").mockImplementation((...args: Parameters<typeof add>) => {
      listeners.push(args);
      add(...args);
    });
    document.body.innerHTML = "";
    vi.spyOn(window.parent, "postMessage").mockImplementation((message) => {
      posted.push(message);
    });
  });

  afterEach(() => {
    for (const [type, listener, options] of listeners) document.removeEventListener(type, listener, options);
    for (const [type, listener, options] of windowListeners) window.removeEventListener(type, listener, options);
    vi.restoreAllMocks();
  });

  it("reports a clicked link to the app instead of navigating", () => {
    document.body.innerHTML = '<a href="https://example.com/x">go</a>';
    runFrameScript();

    const anchor = document.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(posted).toContainEqual({
      type: "maish:link",
      url: "https://example.com/x",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("finds the link when the click lands on a nested element", () => {
    document.body.innerHTML =
      '<a href="https://example.com/y"><span id="inner">go</span></a>';
    runFrameScript();

    document
      .getElementById("inner")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(posted).toContainEqual({
      type: "maish:link",
      url: "https://example.com/y",
    });
  });

  it("stays quiet when the click is not on a link", () => {
    document.body.innerHTML = "<p id=\"text\">no link here</p>";
    runFrameScript();
    posted.length = 0;

    document
      .getElementById("text")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(posted).toHaveLength(0);
  });

  it("ignores anchors without an href", () => {
    document.body.innerHTML = '<a id="anchor">no target</a>';
    runFrameScript();
    posted.length = 0;

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("anchor")!.dispatchEvent(event);

    expect(posted).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("reports its height on startup", () => {
    document.body.innerHTML = "<p>body</p>";
    // jsdom does no layout, so scrollHeight is always 0 without this
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(321);
    runFrameScript();

    const heights = posted.filter(
      (m): m is { type: string; height: number } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "maish:height",
    );
    expect(heights.length).toBeGreaterThan(0);
    expect(heights[0]!.height).toBe(321);
  });
  describe("key reports", () => {
    function key(init: KeyboardEventInit) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(event);
      return event;
    }

    it("hands the zoom keys to the app and keeps the webview from zooming the page", () => {
      runFrameScript();
      posted.length = 0;

      const event = key({ key: "+", ctrlKey: true });
      key({ key: "0", metaKey: true });

      expect(posted).toEqual([
        { type: "maish:key", key: "+", ctrlKey: true, metaKey: false },
        { type: "maish:key", key: "0", ctrlKey: false, metaKey: true },
      ]);
      expect(event.defaultPrevented).toBe(true);
    });

    it("keeps every other key to itself", () => {
      runFrameScript();
      posted.length = 0;

      key({ key: "+" });
      key({ key: "j" });
      key({ key: "c", ctrlKey: true });
      const alt = key({ key: "-", ctrlKey: true, altKey: true });

      expect(posted).toHaveLength(0);
      expect(alt.defaultPrevented).toBe(false);
    });
  });

  describe("wheel reports", () => {
    function wheel(target: Element, init: WheelEventInit, timeStamp?: number) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
      target.dispatchEvent(event);
    }

    function makeScrollable(el: HTMLElement, scrollLeft: number) {
      el.style.overflowX = "auto";
      Object.defineProperty(el, "scrollWidth", { value: 500, configurable: true });
      Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
      el.scrollLeft = scrollLeft;
    }

    it("reports wheel deltas to the app", () => {
      document.body.innerHTML = '<p id="t">text</p>';
      runFrameScript();
      posted.length = 0;

      wheel(document.getElementById("t")!, { deltaX: 12, deltaY: 3, deltaMode: 0 });

      expect(posted).toContainEqual({ type: "maish:wheel", deltaX: 12, deltaY: 3, deltaMode: 0 });
    });

    it("reports pinch-zoom (ctrl+wheel) for the app to zoom the body, and stops the webview zooming", () => {
      document.body.innerHTML = '<p id="t">text</p>';
      runFrameScript();
      posted.length = 0;

      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 3, deltaY: 5, ctrlKey: true });
      document.getElementById("t")!.dispatchEvent(event);

      expect(posted).toEqual([{ type: "maish:wheel", ctrlKey: true, deltaX: 0, deltaY: 5, deltaMode: 0 }]);
      expect(event.defaultPrevented).toBe(true);
    });

    it("leaves a gesture to content that can still scroll sideways", () => {
      document.body.innerHTML = '<pre id="wide">wide</pre>';
      const pre = document.getElementById("wide")!;
      makeScrollable(pre, 0);
      runFrameScript();
      posted.length = 0;

      wheel(pre, { deltaX: 10 }, 1000);
      // The content reaches its edge mid-gesture; the gesture stays with it.
      pre.scrollLeft = 400;
      wheel(pre, { deltaX: 10 }, 1016);

      expect(posted).toHaveLength(0);
    });

    it("decides who owns a gesture on its first event with motion", () => {
      document.body.innerHTML = '<pre id="wide">wide</pre>';
      const pre = document.getElementById("wide")!;
      makeScrollable(pre, 0);
      runFrameScript();
      posted.length = 0;

      wheel(pre, { deltaX: 0, deltaY: 0 }, 1000);
      wheel(pre, { deltaX: 10 }, 1016);

      expect(posted).toHaveLength(0);
    });

    it("reports a gesture that starts with the content at its edge", () => {
      document.body.innerHTML = '<pre id="wide">wide</pre>';
      const pre = document.getElementById("wide")!;
      makeScrollable(pre, 400);
      runFrameScript();
      posted.length = 0;

      wheel(pre, { deltaX: 10 }, 1000);

      expect(posted).toHaveLength(1);
    });

    it("reports content that scrolls sideways only the other way", () => {
      document.body.innerHTML = '<pre id="wide">wide</pre>';
      const pre = document.getElementById("wide")!;
      makeScrollable(pre, 400);
      runFrameScript();
      posted.length = 0;

      // Fingers moving right (negative deltaX) scroll the content back left.
      wheel(pre, { deltaX: -10 }, 1000);

      expect(posted).toHaveLength(0);
    });
  });

  describe("mouse side buttons", () => {
    function press(type: "mousedown" | "mouseup", button: number) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
      document.body.dispatchEvent(event);
      return event;
    }

    it("reports the back and forward buttons and keeps the webview from navigating", () => {
      runFrameScript();
      posted.length = 0;

      expect(press("mousedown", 3).defaultPrevented).toBe(true);
      expect(press("mouseup", 3).defaultPrevented).toBe(true);
      press("mouseup", 4);

      expect(posted).toEqual([
        { type: "maish:mouse", button: 3 },
        { type: "maish:mouse", button: 4 },
      ]);
    });

    it("leaves the other buttons alone", () => {
      runFrameScript();
      posted.length = 0;

      expect(press("mousedown", 0).defaultPrevented).toBe(false);
      press("mouseup", 0);
      press("mouseup", 1);

      expect(posted).toHaveLength(0);
    });
  });

  describe("zoom", () => {
    function tell(data: unknown, source: MessageEventSource | null = window) {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    }

    it("zooms the body to the level the app sends and reports the new height", () => {
      document.body.innerHTML = "<p>body</p>";
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(200);
      runFrameScript();
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(300);
      posted.length = 0;

      tell({ type: "maish:zoom", zoom: 1.5 });

      expect(document.body.style.zoom).toBe("1.5");
      expect(posted).toContainEqual({ type: "maish:height", height: 300 });
    });

    it("ignores a level that is not a positive number", () => {
      runFrameScript();
      document.body.style.zoom = "1";

      tell({ type: "maish:zoom", zoom: "2" });
      tell({ type: "maish:zoom", zoom: 0 });
      tell({ type: "maish:zoom", zoom: Infinity });
      tell({ type: "maish:zoom", zoom: -1 });

      expect(document.body.style.zoom).toBe("1");
    });

    it("ignores a level that did not come from the app window", () => {
      runFrameScript();
      document.body.style.zoom = "1";

      tell({ type: "maish:zoom", zoom: 2 }, null);

      expect(document.body.style.zoom).toBe("1");
    });
  });
});
