import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeDate } from "./date";

describe("formatRelativeDate", () => {
  afterEach(() => vi.useRealTimers());

  it("gives a date in the coming days as a date, not as a weekday that reads as past", () => {
    // Scheduled sends and snoozes lie ahead; "Fri" for next Friday reads as last Friday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0));
    const inThreeDays = new Date(2026, 10, 14, 9, 0).getTime();

    expect(formatRelativeDate(inThreeDays)).toBe(
      new Date(inThreeDays).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  it("still names the weekday for the last few days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0));
    const threeDaysAgo = new Date(2026, 10, 8, 9, 0).getTime();

    expect(formatRelativeDate(threeDaysAgo)).toBe(
      new Date(threeDaysAgo).toLocaleDateString(undefined, { weekday: "short" }),
    );
  });
});
