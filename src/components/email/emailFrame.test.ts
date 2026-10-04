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

  beforeEach(() => {
    posted = [];
    // The script listens on `document`, which outlives a test; take its listeners off again.
    listeners = [];
    const add = document.addEventListener.bind(document);
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

    it("keeps pinch-zoom (ctrl+wheel) to itself", () => {
      document.body.innerHTML = '<p id="t">text</p>';
      runFrameScript();
      posted.length = 0;

      wheel(document.getElementById("t")!, { deltaX: 0, deltaY: 5, ctrlKey: true });

      expect(posted).toHaveLength(0);
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
});
