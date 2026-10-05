import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "./uiStore";

vi.mock("@/services/db/settings", () => ({
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { setSetting } from "@/services/db/settings";

describe("uiStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      theme: "system",
      sidebarCollapsed: false,
      readingPanePosition: "right",
      readFilter: "all",
      fontScale: "default",
      inboxViewMode: "unified",
    });
  });

  it("should have correct default values", () => {
    const state = useUIStore.getState();
    expect(state.theme).toBe("system");
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.readingPanePosition).toBe("right");
  });

  it("should keep a startup error until it is cleared", () => {
    expect(useUIStore.getState().startupError).toBeNull();
    useUIStore.getState().setStartupError("Could not decrypt the IMAP password");
    expect(useUIStore.getState().startupError).toBe("Could not decrypt the IMAP password");
    useUIStore.getState().setStartupError(null);
    expect(useUIStore.getState().startupError).toBeNull();
  });

  it("should set theme", () => {
    useUIStore.getState().setTheme("dark");
    expect(useUIStore.getState().theme).toBe("dark");
  });

  it("should toggle sidebar", () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("should persist sidebar state on toggle", () => {
    useUIStore.getState().toggleSidebar();
    expect(setSetting).toHaveBeenCalledWith("sidebar_collapsed", "true");

    useUIStore.getState().toggleSidebar();
    expect(setSetting).toHaveBeenCalledWith("sidebar_collapsed", "false");
  });

  it("should set sidebar collapsed directly", () => {
    useUIStore.getState().setSidebarCollapsed(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);

    useUIStore.getState().setSidebarCollapsed(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("should set reading pane position", () => {
    useUIStore.getState().setReadingPanePosition("bottom");
    expect(useUIStore.getState().readingPanePosition).toBe("bottom");
  });

  it("setReadingPanePosition should persist to DB settings", () => {
    useUIStore.getState().setReadingPanePosition("bottom");
    expect(setSetting).toHaveBeenCalledWith("reading_pane_position", "bottom");
    expect(useUIStore.getState().readingPanePosition).toBe("bottom");

    useUIStore.getState().setReadingPanePosition("hidden");
    expect(setSetting).toHaveBeenCalledWith("reading_pane_position", "hidden");
    expect(useUIStore.getState().readingPanePosition).toBe("hidden");
  });

  it("setReadFilter should persist to DB settings", () => {
    useUIStore.getState().setReadFilter("unread");
    expect(setSetting).toHaveBeenCalledWith("read_filter", "unread");
    expect(useUIStore.getState().readFilter).toBe("unread");

    useUIStore.getState().setReadFilter("read");
    expect(setSetting).toHaveBeenCalledWith("read_filter", "read");
    expect(useUIStore.getState().readFilter).toBe("read");
  });

  it("setEmailDensity should persist to DB and update state", () => {
    expect(useUIStore.getState().emailDensity).toBe("default");

    useUIStore.getState().setEmailDensity("compact");
    expect(setSetting).toHaveBeenCalledWith("email_density", "compact");
    expect(useUIStore.getState().emailDensity).toBe("compact");

    useUIStore.getState().setEmailDensity("spacious");
    expect(setSetting).toHaveBeenCalledWith("email_density", "spacious");
    expect(useUIStore.getState().emailDensity).toBe("spacious");
  });

  it("swipe buttons default to delete/archive on the left and read/snooze on the right, and persist", () => {
    expect(useUIStore.getState().swipeLeftActions).toEqual(["trash", "archive"]);
    expect(useUIStore.getState().swipeRightActions).toEqual(["toggleRead", "snooze"]);

    useUIStore.getState().setSwipeLeftActions(["archive", "star"]);
    expect(setSetting).toHaveBeenCalledWith("swipe_left_actions", '["archive","star"]');
    expect(useUIStore.getState().swipeLeftActions).toEqual(["archive", "star"]);

    useUIStore.getState().setSwipeRightActions([]);
    expect(setSetting).toHaveBeenCalledWith("swipe_right_actions", "[]");
    expect(useUIStore.getState().swipeRightActions).toEqual([]);
  });

  it("keeps at most three distinct real swipe buttons", () => {
    useUIStore.getState().setSwipeLeftActions(["trash", "trash", "none", "archive", "star", "spam"] as never);
    expect(useUIStore.getState().swipeLeftActions).toEqual(["trash", "archive", "star"]);
  });

  it("keeps one swipe open at a time", () => {
    useUIStore.getState().setOpenSwipe({ threadId: "a", side: "left" });
    useUIStore.getState().setOpenSwipe({ threadId: "b", side: "right" });
    expect(useUIStore.getState().openSwipe).toEqual({ threadId: "b", side: "right" });
    useUIStore.getState().setOpenSwipe(null);
    expect(useUIStore.getState().openSwipe).toBeNull();
  });

  it("setDefaultReplyMode should persist to DB and update state", () => {
    expect(useUIStore.getState().defaultReplyMode).toBe("reply");

    useUIStore.getState().setDefaultReplyMode("replyAll");
    expect(setSetting).toHaveBeenCalledWith("default_reply_mode", "replyAll");
    expect(useUIStore.getState().defaultReplyMode).toBe("replyAll");

    useUIStore.getState().setDefaultReplyMode("reply");
    expect(setSetting).toHaveBeenCalledWith("default_reply_mode", "reply");
    expect(useUIStore.getState().defaultReplyMode).toBe("reply");
  });

  it("setMarkAsReadBehavior should persist to DB and update state", () => {
    expect(useUIStore.getState().markAsReadBehavior).toBe("instant");

    useUIStore.getState().setMarkAsReadBehavior("2s");
    expect(setSetting).toHaveBeenCalledWith("mark_as_read_behavior", "2s");
    expect(useUIStore.getState().markAsReadBehavior).toBe("2s");

    useUIStore.getState().setMarkAsReadBehavior("manual");
    expect(setSetting).toHaveBeenCalledWith("mark_as_read_behavior", "manual");
    expect(useUIStore.getState().markAsReadBehavior).toBe("manual");
  });

  it("setFontScale should persist to DB and update state", () => {
    expect(useUIStore.getState().fontScale).toBe("default");

    useUIStore.getState().setFontScale("large");
    expect(setSetting).toHaveBeenCalledWith("font_size", "large");
    expect(useUIStore.getState().fontScale).toBe("large");

    useUIStore.getState().setFontScale("small");
    expect(setSetting).toHaveBeenCalledWith("font_size", "small");
    expect(useUIStore.getState().fontScale).toBe("small");

    useUIStore.getState().setFontScale("xlarge");
    expect(setSetting).toHaveBeenCalledWith("font_size", "xlarge");
    expect(useUIStore.getState().fontScale).toBe("xlarge");
  });

  it("setSendAndArchive should persist to DB and update state", () => {
    expect(useUIStore.getState().sendAndArchive).toBe(false);

    useUIStore.getState().setSendAndArchive(true);
    expect(setSetting).toHaveBeenCalledWith("send_and_archive", "true");
    expect(useUIStore.getState().sendAndArchive).toBe(true);

    useUIStore.getState().setSendAndArchive(false);
    expect(setSetting).toHaveBeenCalledWith("send_and_archive", "false");
    expect(useUIStore.getState().sendAndArchive).toBe(false);
  });

  it("sidebarNavConfig should default to null", () => {
    expect(useUIStore.getState().sidebarNavConfig).toBe(null);
  });

  it("setSidebarNavConfig should persist to DB and update state", () => {
    const config = [
      { id: "inbox", visible: true },
      { id: "starred", visible: false },
      { id: "sent", visible: true },
    ];
    useUIStore.getState().setSidebarNavConfig(config);
    expect(setSetting).toHaveBeenCalledWith("sidebar_nav_config", JSON.stringify(config));
    expect(useUIStore.getState().sidebarNavConfig).toEqual(config);
  });

  it("restoreSidebarNavConfig should update state without persisting", () => {
    const config = [
      { id: "inbox", visible: true },
      { id: "tasks", visible: true },
    ];
    vi.clearAllMocks();
    useUIStore.getState().restoreSidebarNavConfig(config);
    expect(useUIStore.getState().sidebarNavConfig).toEqual(config);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("inboxViewMode should default to unified", () => {
    expect(useUIStore.getState().inboxViewMode).toBe("unified");
  });

  it("setInboxViewMode should persist to DB and update state", () => {
    useUIStore.getState().setInboxViewMode("split");
    expect(setSetting).toHaveBeenCalledWith("inbox_view_mode", "split");
    expect(useUIStore.getState().inboxViewMode).toBe("split");

    useUIStore.getState().setInboxViewMode("unified");
    expect(setSetting).toHaveBeenCalledWith("inbox_view_mode", "unified");
    expect(useUIStore.getState().inboxViewMode).toBe("unified");
  });

  it("reduceMotion should default to false", () => {
    expect(useUIStore.getState().reduceMotion).toBe(false);
  });

  it("setReduceMotion should persist to DB and update state", () => {
    useUIStore.getState().setReduceMotion(true);
    expect(setSetting).toHaveBeenCalledWith("reduce_motion", "true");
    expect(useUIStore.getState().reduceMotion).toBe(true);

    useUIStore.getState().setReduceMotion(false);
    expect(setSetting).toHaveBeenCalledWith("reduce_motion", "false");
    expect(useUIStore.getState().reduceMotion).toBe(false);
  });


  describe("mail zoom", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      useUIStore.setState({ mailZoom: 1 });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("clamps the zoom to the allowed range", () => {
      useUIStore.getState().setMailZoom(10);
      expect(useUIStore.getState().mailZoom).toBe(3);
      useUIStore.getState().setMailZoom(0);
      expect(useUIStore.getState().mailZoom).toBe(0.5);
    });

    it("keeps a fraction of a percent live but saves whole percent", () => {
      useUIStore.getState().setMailZoom(1.0034);
      expect(useUIStore.getState().mailZoom).toBe(1.0034);
      vi.advanceTimersByTime(400);
      expect(setSetting).toHaveBeenCalledWith("mail_zoom", "1");
    });

    it("saves only the last level of a burst of changes", () => {
      useUIStore.getState().setMailZoom(1.1);
      useUIStore.getState().setMailZoom(1.2);
      useUIStore.getState().setMailZoom(1.3);
      expect(setSetting).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(setSetting).toHaveBeenCalledTimes(1);
      expect(setSetting).toHaveBeenCalledWith("mail_zoom", "1.3");
    });
  });
});
