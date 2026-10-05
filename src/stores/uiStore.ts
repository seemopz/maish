import { create } from "zustand";
import { setSetting } from "@/services/db/settings";
import { clampMailZoom, roundMailZoom, MAIL_ZOOM_DEFAULT } from "@/utils/mailZoom";
import { DEFAULT_SWIPE_LEFT, DEFAULT_SWIPE_RIGHT, normalizeSwipeActions, type SwipeButtonAction } from "@/utils/swipeActions";

type Theme = "light" | "dark" | "system";
type ReadingPanePosition = "right" | "bottom" | "hidden";
type ReadFilter = "all" | "read" | "unread";
export type EmailDensity = "compact" | "default" | "spacious";
export type DefaultReplyMode = "reply" | "replyAll";
export type MarkAsReadBehavior = "instant" | "2s" | "manual";
export type FontScale = "small" | "default" | "large" | "xlarge";
export type InboxViewMode = "unified" | "split";

export type SyncState = "idle" | "syncing" | "error";

export interface SidebarNavItem {
  id: string;
  visible: boolean;
}

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  contactSidebarVisible: boolean;
  readingPanePosition: ReadingPanePosition;
  readFilter: ReadFilter;
  emailListWidth: number;
  emailDensity: EmailDensity;
  /** Buttons a swipe to the left opens, in order; the first is what a full swipe runs. */
  swipeLeftActions: SwipeButtonAction[];
  swipeRightActions: SwipeButtonAction[];
  /** The thread card whose swipe buttons are open (one at a time). */
  openSwipe: { threadId: string; side: "left" | "right" } | null;
  /** Zoom factor of the mail body, 1 = 100 %. */
  mailZoom: number;
  defaultReplyMode: DefaultReplyMode;
  markAsReadBehavior: MarkAsReadBehavior;
  fontScale: FontScale;
  sendAndArchive: boolean;
  inboxViewMode: InboxViewMode;
  taskSidebarVisible: boolean;
  sidebarNavConfig: SidebarNavItem[] | null;
  reduceMotion: boolean;
  isOnline: boolean;
  /** Why the app could not load its accounts or credentials at startup; shown in a banner. */
  startupError: string | null;
  pendingOpsCount: number;
  isSyncingFolder: string | null;
  syncState: SyncState;
  /** Progress text while syncing, error text after a failed sync. */
  syncMessage: string | null;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleContactSidebar: () => void;
  setContactSidebarVisible: (visible: boolean) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setReadFilter: (filter: ReadFilter) => void;
  setEmailListWidth: (width: number) => void;
  setEmailDensity: (density: EmailDensity) => void;
  setSwipeLeftActions: (actions: SwipeButtonAction[]) => void;
  setSwipeRightActions: (actions: SwipeButtonAction[]) => void;
  setOpenSwipe: (open: { threadId: string; side: "left" | "right" } | null) => void;
  setMailZoom: (zoom: number) => void;
  setDefaultReplyMode: (mode: DefaultReplyMode) => void;
  setMarkAsReadBehavior: (behavior: MarkAsReadBehavior) => void;
  setFontScale: (scale: FontScale) => void;
  setSendAndArchive: (enabled: boolean) => void;
  setInboxViewMode: (mode: InboxViewMode) => void;
  toggleTaskSidebar: () => void;
  setTaskSidebarVisible: (visible: boolean) => void;
  setSidebarNavConfig: (config: SidebarNavItem[]) => void;
  restoreSidebarNavConfig: (config: SidebarNavItem[]) => void;
  setReduceMotion: (reduce: boolean) => void;
  setOnline: (online: boolean) => void;
  setStartupError: (message: string | null) => void;
  setPendingOpsCount: (count: number) => void;
  setSyncingFolder: (folder: string | null) => void;
  setSyncState: (state: SyncState, message?: string | null) => void;
}

// A pinch sends a stream of zoom steps; only the last one is worth writing down.
let zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
const ZOOM_SAVE_DELAY_MS = 300;

export const useUIStore = create<UIState>((set) => ({
  theme: "system",
  sidebarCollapsed: false,
  contactSidebarVisible: true,
  readingPanePosition: "right",
  readFilter: "all",
  emailListWidth: 320,
  emailDensity: "default",
  swipeLeftActions: [...DEFAULT_SWIPE_LEFT],
  swipeRightActions: [...DEFAULT_SWIPE_RIGHT],
  openSwipe: null,
  mailZoom: MAIL_ZOOM_DEFAULT,
  defaultReplyMode: "reply",
  markAsReadBehavior: "instant",
  fontScale: "default",
  sendAndArchive: false,
  inboxViewMode: "unified",
  taskSidebarVisible: false,
  sidebarNavConfig: null,
  reduceMotion: false,
  isOnline: true,
  startupError: null,
  pendingOpsCount: 0,
  isSyncingFolder: null,
  syncState: "idle",
  syncMessage: null,

  setTheme: (theme) => set({ theme }),
  toggleSidebar: () =>
    set((state) => {
      const collapsed = !state.sidebarCollapsed;
      setSetting("sidebar_collapsed", String(collapsed)).catch(() => {});
      return { sidebarCollapsed: collapsed };
    }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleContactSidebar: () =>
    set((state) => {
      const visible = !state.contactSidebarVisible;
      setSetting("contact_sidebar_visible", String(visible)).catch(() => {});
      return { contactSidebarVisible: visible };
    }),
  setContactSidebarVisible: (contactSidebarVisible) => set({ contactSidebarVisible }),
  setReadingPanePosition: (readingPanePosition) => {
    setSetting("reading_pane_position", readingPanePosition).catch(() => {});
    set({ readingPanePosition });
  },
  setReadFilter: (readFilter) => {
    setSetting("read_filter", readFilter).catch(() => {});
    set({ readFilter });
  },
  setEmailListWidth: (emailListWidth) => {
    setSetting("email_list_width", String(emailListWidth)).catch(() => {});
    set({ emailListWidth });
  },
  setEmailDensity: (emailDensity) => {
    setSetting("email_density", emailDensity).catch(() => {});
    set({ emailDensity });
  },
  setSwipeLeftActions: (actions) => {
    const swipeLeftActions = normalizeSwipeActions(actions);
    setSetting("swipe_left_actions", JSON.stringify(swipeLeftActions)).catch(() => {});
    set({ swipeLeftActions });
  },
  setSwipeRightActions: (actions) => {
    const swipeRightActions = normalizeSwipeActions(actions);
    setSetting("swipe_right_actions", JSON.stringify(swipeRightActions)).catch(() => {});
    set({ swipeRightActions });
  },
  setOpenSwipe: (openSwipe) => set({ openSwipe }),
  setMailZoom: (zoom) => {
    const mailZoom = clampMailZoom(zoom);
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => {
      setSetting("mail_zoom", String(roundMailZoom(mailZoom))).catch(() => {});
    }, ZOOM_SAVE_DELAY_MS);
    set({ mailZoom });
  },
  setDefaultReplyMode: (defaultReplyMode) => {
    setSetting("default_reply_mode", defaultReplyMode).catch(() => {});
    set({ defaultReplyMode });
  },
  setMarkAsReadBehavior: (markAsReadBehavior) => {
    setSetting("mark_as_read_behavior", markAsReadBehavior).catch(() => {});
    set({ markAsReadBehavior });
  },
  setFontScale: (fontScale) => {
    setSetting("font_size", fontScale).catch(() => {});
    set({ fontScale });
  },
  setSendAndArchive: (sendAndArchive) => {
    setSetting("send_and_archive", String(sendAndArchive)).catch(() => {});
    set({ sendAndArchive });
  },
  setInboxViewMode: (inboxViewMode) => {
    setSetting("inbox_view_mode", inboxViewMode).catch(() => {});
    set({ inboxViewMode });
  },
  toggleTaskSidebar: () =>
    set((state) => {
      const visible = !state.taskSidebarVisible;
      setSetting("task_sidebar_visible", String(visible)).catch(() => {});
      return { taskSidebarVisible: visible };
    }),
  setTaskSidebarVisible: (taskSidebarVisible) => set({ taskSidebarVisible }),
  setSidebarNavConfig: (sidebarNavConfig) => {
    setSetting("sidebar_nav_config", JSON.stringify(sidebarNavConfig)).catch(() => {});
    set({ sidebarNavConfig });
  },
  restoreSidebarNavConfig: (sidebarNavConfig) => set({ sidebarNavConfig }),
  setReduceMotion: (reduceMotion) => {
    setSetting("reduce_motion", String(reduceMotion)).catch(() => {});
    set({ reduceMotion });
  },
  setOnline: (isOnline) => set({ isOnline }),
  setStartupError: (startupError) => set({ startupError }),
  setPendingOpsCount: (pendingOpsCount) => set({ pendingOpsCount }),
  setSyncingFolder: (isSyncingFolder) => set({ isSyncingFolder }),
  setSyncState: (syncState, syncMessage = null) => set({ syncState, syncMessage }),
}));
