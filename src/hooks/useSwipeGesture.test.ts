import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSwipeGesture, SWIPE_IDLE_MS } from "./useSwipeGesture";

function makeEl(width = 400): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: width });
  return el;
}

function wheel(el: HTMLElement, deltaX: number, deltaY = 0, init: WheelEventInit = {}): WheelEvent {
  const e = new WheelEvent("wheel", { deltaX, deltaY, cancelable: true, bubbles: true, ...init });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}

function quiet() {
  act(() => {
    vi.advanceTimersByTime(SWIPE_IDLE_MS + 1);
  });
}

describe("useSwipeGesture", () => {
  const onCommit = vi.fn();

  function setup(opts: Partial<Parameters<typeof useSwipeGesture>[1]> = {}, width = 400) {
    const el = makeEl(width);
    const ref = { current: el };
    const hook = renderHook(() =>
      useSwipeGesture(ref, {
        enabled: true,
        allowLeft: true,
        allowRight: true,
        onCommit,
        ...opts,
      }),
    );
    return { el, hook };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    onCommit.mockClear();
  });
  afterEach(() => {
    quiet(); // ends the module-wide lock a test may have left behind
    vi.useRealTimers();
  });

  it("follows the fingers: deltaX > 0 moves the card left", () => {
    const { el, hook } = setup();
    wheel(el, 30);
    wheel(el, 20);
    expect(hook.result.current.offset).toBe(-50);
  });

  it("commits left when released past 25 % of the width", () => {
    const { el } = setup();
    wheel(el, 100);
    wheel(el, 80);
    quiet();
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  it("commits right for negative deltaX", () => {
    const { el } = setup();
    wheel(el, -100);
    wheel(el, -80);
    quiet();
    expect(onCommit).toHaveBeenCalledWith("right");
  });

  it("snaps back without committing below the threshold", () => {
    const { el, hook } = setup();
    wheel(el, 60);
    wheel(el, 20); // 80 < 100
    quiet();
    expect(onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.offset).toBe(0);
  });

  it("reports armed once the threshold is crossed", () => {
    const { el, hook } = setup();
    wheel(el, 60);
    expect(hook.result.current.armed).toBe(false);
    wheel(el, 50);
    expect(hook.result.current.armed).toBe(true);
  });

  it("ignores a gesture that starts vertical and lets the browser scroll", () => {
    const { el, hook } = setup();
    const first = wheel(el, 5, 40);
    wheel(el, 200, 2);
    wheel(el, 200, 2);
    quiet();
    expect(first.defaultPrevented).toBe(false);
    expect(hook.result.current.offset).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cancels when vertical motion takes over before the swipe locks in", () => {
    const { el, hook } = setup();
    wheel(el, 6, 1);
    wheel(el, 1, 20);
    wheel(el, 300, 0);
    quiet();
    expect(hook.result.current.offset).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("tolerates vertical jitter once the swipe has locked in", () => {
    const { el } = setup();
    wheel(el, 60, 1);
    wheel(el, 60, 40);
    wheel(el, 60, 1);
    quiet();
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  it("starts a new gesture after the quiet period", () => {
    const { el } = setup();
    wheel(el, 200);
    quiet();
    wheel(el, 200);
    quiet();
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("releases on decaying momentum and ignores the tail", () => {
    const { el } = setup();
    for (const dx of [60, 80, 70, 50, 30, 20, 12, 8, 5, 3, 2, 1]) wheel(el, dx);
    // Released as soon as the decay was recognised, before the events stopped.
    expect(onCommit).toHaveBeenCalledTimes(1);
    quiet();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not let momentum from a sub-threshold swipe start another one", () => {
    const { el, hook } = setup();
    for (const dx of [10, 15, 12, 9, 5, 3, 2, 1, 1]) wheel(el, dx);
    expect(onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.offset).toBe(0);
    quiet();
  });

  it("commits a slow, controlled swipe that eases off before the fingers lift", () => {
    const { el } = setup();
    for (const dx of [4, 8, 12, 16, 16, 14, 12, 10, 8, 6, 4, 3, 2]) wheel(el, dx);
    quiet();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  it("does not commit a short two-finger tap or scroll", () => {
    const { el } = setup();
    for (const dx of [10, 15, 10, 5]) wheel(el, dx);
    quiet();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("caps the threshold on a wide element", () => {
    const { el } = setup({}, 1200);
    wheel(el, 130);
    quiet();
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  describe("momentum after a commit", () => {
    // A flick: ramp up, then a long exponential decay the OS plays out after the fingers left.
    const flick = (() => {
      const out = [40, 80, 120, 160];
      for (let v = 160 * 0.85; v >= 1; v *= 0.85) out.push(Math.round(v));
      return out;
    })();

    it("does not start a second swipe on the card that slides under the pointer", () => {
      const a = setup();
      const b = setup();
      let i = 0;
      while (onCommit.mock.calls.length === 0 && i < flick.length) wheel(a.el, flick[i++]);
      expect(onCommit).toHaveBeenCalledTimes(1);
      // Card A is gone; the tail now reaches card B, which has a fresh hook.
      while (i < flick.length) wheel(b.el, flick[i++]);
      quiet();
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(b.hook.result.current.offset).toBe(0);
    });

    it("swipes again once the tail has been quiet", () => {
      const a = setup();
      const b = setup();
      let i = 0;
      while (onCommit.mock.calls.length === 0 && i < flick.length) wheel(a.el, flick[i++]);
      while (i < flick.length) wheel(b.el, flick[i++]);
      quiet();
      wheel(b.el, 200);
      quiet();
      expect(onCommit).toHaveBeenCalledTimes(2);
    });
  });

  it("clamps the offset to the element width", () => {
    const { el, hook } = setup({}, 300);
    wheel(el, 250);
    wheel(el, 250);
    expect(hook.result.current.offset).toBe(-300);
  });

  it("does not move toward a direction that is switched off", () => {
    const { el, hook } = setup({ allowLeft: false });
    wheel(el, 200);
    expect(hook.result.current.offset).toBe(0);
    quiet();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores pinch-zoom (ctrl+wheel)", () => {
    const { el, hook } = setup();
    wheel(el, 200, 0, { ctrlKey: true });
    quiet();
    expect(hook.result.current.offset).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", () => {
    const { el, hook } = setup({ enabled: false });
    const e = wheel(el, 300);
    quiet();
    expect(e.defaultPrevented).toBe(false);
    expect(hook.result.current.offset).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  describe("touch", () => {
    function pointer(
      el: HTMLElement,
      type: string,
      x: number,
      y = 0,
      init: PointerEventInit & { pointerType?: string } = {},
    ) {
      const e = new MouseEvent(type, { clientX: x, clientY: y, cancelable: true, bubbles: true });
      Object.defineProperties(e, {
        pointerId: { value: init.pointerId ?? 1 },
        pointerType: { value: init.pointerType ?? "touch" },
        isPrimary: { value: init.isPrimary ?? true },
      });
      act(() => {
        el.dispatchEvent(e);
      });
    }

    it("follows one finger and commits right when lifted past the threshold", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 120);
      pointer(el, "pointermove", 230);
      expect(hook.result.current.offset).toBe(180);
      expect(hook.result.current.armed).toBe(true);
      pointer(el, "pointerup", 230);
      expect(onCommit).toHaveBeenCalledWith("right");
      expect(hook.result.current.offset).toBe(0);
    });

    it("commits left for a finger moving left", () => {
      const { el } = setup();
      pointer(el, "pointerdown", 300);
      pointer(el, "pointermove", 100);
      pointer(el, "pointerup", 100);
      expect(onCommit).toHaveBeenCalledWith("left");
    });

    it("snaps back below the threshold", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 110); // 60 < 100
      pointer(el, "pointerup", 110);
      expect(onCommit).not.toHaveBeenCalled();
      expect(hook.result.current.offset).toBe(0);
    });

    it("leaves a vertical start to scrolling", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50, 50);
      pointer(el, "pointermove", 60, 120);
      pointer(el, "pointermove", 300, 130);
      pointer(el, "pointerup", 300, 130);
      expect(hook.result.current.offset).toBe(0);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("stays idle for movement inside the slop (a tap)", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 55);
      expect(hook.result.current.offset).toBe(0);
    });

    it("drops the swipe on pointercancel (browser took over)", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 230);
      pointer(el, "pointercancel", 230);
      expect(hook.result.current.offset).toBe(0);
      pointer(el, "pointerup", 230);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("never swipes with a mouse", () => {
      const { el, hook } = setup();
      pointer(el, "pointerdown", 50, 0, { pointerType: "mouse" });
      pointer(el, "pointermove", 300, 0, { pointerType: "mouse" });
      pointer(el, "pointerup", 300, 0, { pointerType: "mouse" });
      expect(hook.result.current.offset).toBe(0);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("respects a disallowed direction", () => {
      const { el, hook } = setup({ allowRight: false });
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 300);
      expect(hook.result.current.offset).toBe(0);
      pointer(el, "pointerup", 300);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("swallows the click that follows a swipe, then lets clicks through", () => {
      const { el } = setup();
      const onClick = vi.fn();
      el.addEventListener("click", onClick);
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 120);
      pointer(el, "pointerup", 120);
      act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(onClick).not.toHaveBeenCalled();
      // once: a second click right after is a real tap
      act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("lets clicks through again after the suppression window when no click came", () => {
      const { el } = setup();
      const onClick = vi.fn();
      el.addEventListener("click", onClick);
      pointer(el, "pointerdown", 50);
      pointer(el, "pointermove", 120);
      pointer(el, "pointerup", 120);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
