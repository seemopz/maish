import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Thread } from "@/stores/threadStore";

const actions = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  trashThread: vi.fn(),
  markThreadRead: vi.fn(),
  starThread: vi.fn(),
  spamThread: vi.fn(),
}));
vi.mock("@/services/emailActions", () => actions);

import { runSwipeAction } from "./swipeActions";

const thread = { id: "t1", accountId: "a1", isRead: false, isStarred: true, labelIds: ["INBOX"] } as Thread;

describe("runSwipeAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes through the email action layer", async () => {
    await runSwipeAction("trash", thread);
    expect(actions.trashThread).toHaveBeenCalledWith("a1", "t1", []);
    await runSwipeAction("archive", thread);
    expect(actions.archiveThread).toHaveBeenCalledWith("a1", "t1", []);
  });

  it("toggles read, star and spam from the thread's state", async () => {
    await runSwipeAction("toggleRead", thread);
    expect(actions.markThreadRead).toHaveBeenCalledWith("a1", "t1", [], true);
    await runSwipeAction("star", thread);
    expect(actions.starThread).toHaveBeenCalledWith("a1", "t1", [], false);
    await runSwipeAction("spam", thread);
    expect(actions.spamThread).toHaveBeenCalledWith("a1", "t1", [], true);
  });

  it("does nothing for none and snooze", async () => {
    await runSwipeAction("none", thread);
    await runSwipeAction("snooze", thread);
    expect(Object.values(actions).every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});
