import { describe, it, expect } from "vitest";
import type { Thread } from "@/stores/threadStore";
import { resolveSwipeAction, describeSwipeAction, isSwipeAction } from "./swipeActions";

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
});
