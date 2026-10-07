import { describe, it, expect } from "vitest";
import { project, rubber, springAt, velocityOf, SPRING_MS } from "./swipePhysics";

describe("swipePhysics", () => {
  it("reads a signed speed from recent samples", () => {
    expect(velocityOf([[0, 0], [50, 10]], 60)).toBeCloseTo(200);
    expect(velocityOf([[0, 0], [50, -10]], 60)).toBeCloseTo(-200);
  });

  it("reads no speed from stale, too few or too close samples", () => {
    expect(velocityOf([[0, 0], [50, 10]], 400)).toBe(0); // a pause is rest
    expect(velocityOf([[0, 0]], 10)).toBe(0);
    expect(velocityOf([[0, 0], [5, 40]], 10)).toBe(0); // 5 ms say nothing
  });

  it("caps the speed", () => {
    expect(velocityOf([[0, 0], [20, 200]], 20)).toBeLessThanOrEqual(1600);
  });

  it("coasts further the faster the fingers go, and the other way for the other sign", () => {
    expect(project(100)).toBeGreaterThan(0);
    expect(project(-100)).toBeCloseTo(-project(100));
    expect(project(400)).toBeGreaterThan(project(100));
  });

  it("gives less than the pull, flattening out", () => {
    expect(rubber(100, 400)).toBeLessThan(100);
    expect(rubber(400, 400)).toBeLessThan(400 * 0.55);
    expect(rubber(400, 400)).toBeGreaterThan(rubber(100, 400));
    expect(rubber(0, 400)).toBe(0);
  });

  it("runs a critically damped spring from the start to the target without overshoot", () => {
    expect(springAt(0, -100, 0, 0)).toBeCloseTo(-100);
    let last = -100;
    for (let t = 0.01; t < SPRING_MS / 1000; t += 0.01) {
      const x = springAt(t, -100, 0, 0);
      expect(x).toBeGreaterThanOrEqual(last); // monotone towards 0
      expect(x).toBeLessThanOrEqual(0);
      last = x;
    }
    expect(Math.abs(springAt(0.6, -100, 0, 0))).toBeLessThan(1);
  });

  it("starts at the given speed", () => {
    // A speed towards the target moves it sooner than from standstill.
    expect(springAt(0.02, -100, 0, 500)).toBeGreaterThan(springAt(0.02, -100, 0, 0));
  });
});
