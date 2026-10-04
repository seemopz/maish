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
});
