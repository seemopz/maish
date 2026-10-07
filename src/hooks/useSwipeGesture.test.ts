import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSwipeGesture, commitThreshold, isSwipeTail, SWIPE_IDLE_MS } from "./useSwipeGesture";

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

  it("keeps the swipe while the fingers rest on the trackpad", () => {
    const { el, hook } = setup();
    wheel(el, 60);
    wheel(el, 60);
    // Resting fingers send no events; a pause shorter than the hold is not a release.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hook.result.current.active).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    wheel(el, 40);
    expect(hook.result.current.offset).toBe(-160);
    quiet();
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  it("lets a vertical scroll through after a pause and settles the swipe", () => {
    const { el, hook } = setup();
    wheel(el, 30);
    wheel(el, 30);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const e = wheel(el, 0, 40);
    expect(e.defaultPrevented).toBe(false);
    expect(hook.result.current.active).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps a swipe on vertical jitter inside a short pause", () => {
    const { el, hook } = setup();
    wheel(el, 30);
    wheel(el, 30);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    wheel(el, 5, 8);
    expect(hook.result.current.active).toBe(true);
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
    const { el, hook } = setup();
    for (const dx of [4, 8, 12, 16, 16, 14, 12, 10, 8, 6, 6, 5]) wheel(el, dx);
    // Easing off is not momentum: the swipe is still held, and decided by the silence.
    expect(onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.offset).toBe(-117);
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

  describe("two stages", () => {
    const onReveal = vi.fn();
    const two = (opts: Partial<Parameters<typeof useSwipeGesture>[1]> = {}) =>
      setup({ revealLeftPx: 144, revealRightPx: 72, onReveal, ...opts });

    beforeEach(() => onReveal.mockClear());

    it("opens the buttons on a light swipe and runs nothing", () => {
      const { el } = two();
      for (const dx of [20, 25, 25]) wheel(el, dx); // 70 px: past the light threshold, far from the full one
      quiet();
      expect(onReveal).toHaveBeenCalledWith("left");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("runs the default on a full swipe and does not open the buttons", () => {
      const { el, hook } = two();
      for (const dx of [60, 80, 70]) wheel(el, dx); // 210 px of 400
      expect(hook.result.current.armed).toBe(true);
      quiet();
      expect(onCommit).toHaveBeenCalledWith("left");
      expect(onReveal).not.toHaveBeenCalled();
    });

    it("runs the default on a flick, then ignores its momentum tail", () => {
      const { el } = two();
      const flick = [40, 80, 120, 160];
      for (let v = 160 * 0.85; v >= 1; v *= 0.85) flick.push(Math.round(v));
      for (const dx of flick) wheel(el, dx);
      quiet();
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onReveal).not.toHaveBeenCalled();
    });

    it("snaps back below the light threshold", () => {
      const { el, hook } = two();
      for (const dx of [10, 15, 20]) wheel(el, dx); // 45 px
      quiet();
      expect(onReveal).toHaveBeenCalledWith(null);
      expect(onCommit).not.toHaveBeenCalled();
      expect(hook.result.current.offset).toBe(0);
    });

    it("does not let the momentum of a light swipe open or run anything else", () => {
      const { el } = two();
      for (const dx of [12, 18, 16, 12, 8, 5, 3, 2, 1, 1]) wheel(el, dx);
      quiet();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onReveal).toHaveBeenCalledTimes(1);
    });

    it("rests at the width of the open buttons", () => {
      const { hook } = (() => {
        const el = makeEl();
        return {
          hook: renderHook(() =>
            useSwipeGesture({ current: el }, {
              enabled: true, allowLeft: true, allowRight: true, onCommit,
              revealLeftPx: 144, revealRightPx: 72, revealed: "left", onReveal,
            }),
          ),
        };
      })();
      expect(hook.result.current).toEqual({ offset: -144, armed: false, active: false });
    });

    it("starts from the open position and closes on a swipe back", () => {
      const { el } = two({ revealed: "left" });
      for (const dx of [-30, -40, -40]) wheel(el, dx); // -144 + 110 = -34
      quiet();
      expect(onReveal).toHaveBeenCalledWith(null);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps the buttons open when released at the open position", () => {
      const { el } = two({ revealed: "left" });
      wheel(el, 2);
      quiet();
      expect(onReveal).toHaveBeenCalledWith("left");
    });

    it("keeps a side without buttons a one-stage swipe", () => {
      const { el } = two({ revealRightPx: 0 });
      for (const dx of [-60, -40, -30]) wheel(el, dx); // 130 px: past the one-stage threshold (100)
      quiet();
      expect(onCommit).toHaveBeenCalledWith("right");
      expect(onReveal).not.toHaveBeenCalled();
    });

    it("places the full swipe beyond the open buttons", () => {
      expect(commitThreshold(400, 0)).toBe(100);
      expect(commitThreshold(400, 144)).toBe(200);
      expect(commitThreshold(400, 192)).toBe(240); // three buttons: pushed out beyond them
      expect(commitThreshold(200, 192)).toBe(180); // never past 90 % of a narrow card
      expect(commitThreshold(1000, 72)).toBe(220);
    });

    it("closes an open card on a swipe back past the rest position when the other side has no buttons", () => {
      const { el, hook } = two({ revealed: "left", allowRight: false, revealRightPx: 0 });
      for (const dx of [-60, -60, -50]) wheel(el, dx); // -144 + 170, clamped to 0
      quiet();
      expect(onReveal).toHaveBeenCalledWith(null);
      expect(onCommit).not.toHaveBeenCalled();
      expect(hook.result.current.active).toBe(false);
    });

    it("closes the same way with one finger", () => {
      const { el } = two({ revealed: "left", allowRight: false, revealRightPx: 0 });
      const touch = (type: string, x: number) => {
        const e = new MouseEvent(type, { clientX: x, clientY: 0, cancelable: true, bubbles: true });
        Object.defineProperties(e, {
          pointerId: { value: 1 }, pointerType: { value: "touch" }, isPrimary: { value: true },
        });
        act(() => void el.dispatchEvent(e));
      };
      touch("pointerdown", 100);
      touch("pointermove", 200);
      touch("pointermove", 300); // 200 px right, clamped to 0
      touch("pointerup", 300);
      expect(onReveal).toHaveBeenCalledWith(null);
    });

    it("needs a longer swipe to run the default from an open card", () => {
      expect(commitThreshold(320, 128)).toBe(176);
      expect(commitThreshold(320, 128, true)).toBe(224);
      const { el } = two({ revealed: "left" });
      for (const dx of [40, 40, 40]) wheel(el, dx); // -144 - 120 = -264 of 400: past 240 from an open card
      quiet();
      expect(onCommit).toHaveBeenCalledWith("left");
      onCommit.mockClear();
      const again = two({ revealed: "left" });
      for (const dx of [20, 20, 20]) wheel(again.el, dx); // -144 - 60 = -204: short of 240
      quiet();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onReveal).toHaveBeenCalledWith("left");
    });

    it("marks the momentum tail of a horizontal swipe, and only that", () => {
      const { el } = two();
      for (const dx of [12, 18, 16, 12, 8, 5, 3, 2, 1, 1]) wheel(el, dx);
      expect(isSwipeTail()).toBe(true);
      quiet();
      expect(isSwipeTail()).toBe(false);
      wheel(el, 2, 40); // a vertical scroll is no horizontal tail
      expect(isSwipeTail()).toBe(false);
    });

    it("opens with one finger and runs the default with a long drag", () => {
      const { el } = two();
      const touch = (type: string, x: number) => {
        const e = new MouseEvent(type, { clientX: x, clientY: 0, cancelable: true, bubbles: true });
        Object.defineProperties(e, {
          pointerId: { value: 1 }, pointerType: { value: "touch" }, isPrimary: { value: true },
        });
        act(() => void el.dispatchEvent(e));
      };
      touch("pointerdown", 300);
      touch("pointermove", 260);
      touch("pointermove", 220);
      touch("pointerup", 220); // 80 px left
      expect(onReveal).toHaveBeenCalledWith("left");
      touch("pointerdown", 300);
      touch("pointermove", 200);
      touch("pointermove", 80);
      touch("pointerup", 80); // 220 px left
      expect(onCommit).toHaveBeenCalledWith("left");
    });
  });
});
