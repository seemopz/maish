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
    vi.useRealTimers();
  });

  it("follows the fingers: deltaX > 0 moves the card left", () => {
    const { el, hook } = setup();
    wheel(el, 30);
    wheel(el, 20);
    expect(hook.result.current.offset).toBe(-50);
  });

  it("commits left when released past 40 % of the width", () => {
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
    wheel(el, 100);
    wheel(el, 40); // 140 < 160
    quiet();
    expect(onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.offset).toBe(0);
  });

  it("reports armed once the threshold is crossed", () => {
    const { el, hook } = setup();
    wheel(el, 100);
    expect(hook.result.current.armed).toBe(false);
    wheel(el, 70);
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
    for (const dx of [20, 30, 25, 18, 10, 6, 3, 2, 1]) wheel(el, dx);
    expect(onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.offset).toBe(0);
    quiet();
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
      pointer(el, "pointermove", 150); // 100 < 160
      pointer(el, "pointerup", 150);
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
