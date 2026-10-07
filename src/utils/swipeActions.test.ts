import { describe, it, expect } from "vitest";
import type { Thread } from "@/stores/threadStore";
import {
  resolveSwipeAction,
  resolveSwipeActions,
  describeSwipeAction,
  isSwipeAction,
  normalizeSwipeActions,
  parseSwipeActions,
  setSwipeSlot,
  swipeButtonBox,
} from "./swipeActions";

const thread = { isRead: true, isStarred: false, labelIds: ["INBOX"] } as Thread;

describe("swipeActions", () => {
  it("switches the swipe off in drafts, and trash in the trash view", () => {
    expect(resolveSwipeAction("archive", "drafts")).toBe("none");
    expect(resolveSwipeAction("trash", "trash")).toBe("none");
    expect(resolveSwipeAction("archive", "trash")).toBe("archive");
    expect(resolveSwipeAction("trash", "inbox")).toBe("trash");
  });

  it("labels toggles by the thread's current state", () => {
    expect(describeSwipeAction("toggleRead", thread)).toBe("Mark unread");
    expect(describeSwipeAction("toggleRead", { ...thread, isRead: false })).toBe("Mark read");
    expect(describeSwipeAction("star", thread)).toBe("Star");
    expect(describeSwipeAction("spam", { ...thread, labelIds: ["SPAM"] })).toBe("Not spam");
  });

  it("validates stored values", () => {
    expect(isSwipeAction("snooze")).toBe(true);
    expect(isSwipeAction("bogus")).toBe(false);
    expect(isSwipeAction(null)).toBe(false);
  });

  it("drops the actions that must not run in this view", () => {
    expect(resolveSwipeActions(["trash", "archive"], "trash")).toEqual(["archive"]);
    expect(resolveSwipeActions(["trash", "archive"], "drafts")).toEqual([]);
    expect(resolveSwipeActions(["trash", "archive"], "inbox")).toEqual(["trash", "archive"]);
  });

  it("normalizes a list: valid, real, distinct, at most three", () => {
    expect(normalizeSwipeActions(["archive", "bogus", "none", "archive", "star", "spam", "snooze"])).toEqual([
      "archive",
      "star",
      "spam",
    ]);
    expect(normalizeSwipeActions("trash")).toEqual([]);
  });

  describe("parseSwipeActions", () => {
    it("reads the saved list", () => {
      expect(parseSwipeActions('["archive","star"]', "trash")).toEqual(["archive", "star"]);
    });
    it("migrates the single action of older versions to the first button", () => {
      expect(parseSwipeActions(null, "archive")).toEqual(["archive"]);
    });
    it("migrates the old Off to an empty list", () => {
      expect(parseSwipeActions(null, "none")).toEqual([]);
    });
    it("returns null when nothing was saved, or the value is unreadable", () => {
      expect(parseSwipeActions(null, null)).toBeNull();
      expect(parseSwipeActions(null, "bogus")).toBeNull();
      expect(parseSwipeActions("{oops", "trash")).toBeNull();
    });
  });

  describe("setSwipeSlot", () => {
    it("switches the side off when the first slot is set to Off", () => {
      expect(setSwipeSlot(["trash", "archive"], 0, "")).toEqual([]);
    });
    it("drops the later slots when a middle one is emptied", () => {
      expect(setSwipeSlot(["trash", "archive", "star"], 1, "")).toEqual(["trash"]);
    });
    it("replaces and appends a slot", () => {
      expect(setSwipeSlot(["trash", "archive"], 1, "star")).toEqual(["trash", "star"]);
      expect(setSwipeSlot(["trash"], 1, "archive")).toEqual(["trash", "archive"]);
      expect(setSwipeSlot([], 0, "archive")).toEqual(["archive"]);
    });
    it("keeps each action once", () => {
      expect(setSwipeSlot(["trash", "archive"], 1, "trash")).toEqual(["trash"]);
    });
  });
});

describe("swipeButtonBox", () => {
  it("lays the buttons side by side up to their own width", () => {
    expect(swipeButtonBox(0, 2, 100, false, 64)).toEqual({ edge: 0, size: 64 });
    expect(swipeButtonBox(1, 2, 100, false, 64)).toEqual({ edge: 64, size: 64 });
    expect(swipeButtonBox(1, 2, 128, false, 64)).toEqual({ edge: 64, size: 64 });
  });

  it("stretches the first button past that and pushes the others along", () => {
    expect(swipeButtonBox(0, 2, 180, false, 64)).toEqual({ edge: 0, size: 116 });
    expect(swipeButtonBox(1, 2, 180, false, 64)).toEqual({ edge: 116, size: 64 });
    expect(swipeButtonBox(2, 3, 250, false, 64)).toEqual({ edge: 122 + 64, size: 64 });
  });

  it("fills the field with the first and sends the rest out at the full swipe", () => {
    expect(swipeButtonBox(0, 2, 220, true, 64)).toEqual({ edge: 0, size: "100%" });
    expect(swipeButtonBox(1, 2, 220, true, 64)).toEqual({ edge: "100%", size: 64 });
  });

  it("keeps a single button at its width until it is stretched", () => {
    expect(swipeButtonBox(0, 1, 40, false, 64)).toEqual({ edge: 0, size: 64 });
    expect(swipeButtonBox(0, 1, 100, false, 64)).toEqual({ edge: 0, size: 100 });
  });
});
