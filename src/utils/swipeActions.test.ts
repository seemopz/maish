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
