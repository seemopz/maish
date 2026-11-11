import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const plugin = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: plugin.sendNotification,
  registerActionTypes: vi.fn(async () => {}),
  onAction: plugin.onAction,
}));
vi.mock("../db/settings", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn(async () => ({ show: vi.fn(), setFocus: vi.fn() })) },
}));
vi.mock("../../stores/composerStore", () => ({ useComposerStore: { getState: () => ({ openComposer: vi.fn() }) } }));
const navigate = vi.hoisted(() => ({ navigateToLabel: vi.fn() }));
vi.mock("../../router/navigate", () => navigate);
const actions = vi.hoisted(() => ({ archiveThread: vi.fn() }));
vi.mock("../emailActions", () => actions);

import { initNotifications, queueNewEmailNotification, notifyFollowUpDue } from "./notificationManager";

describe("notification actions", () => {
  let handler: (event: Record<string, unknown>) => Promise<void>;

  beforeAll(async () => {
    plugin.onAction.mockImplementation(async (cb: typeof handler) => {
      handler = cb;
    });
    await initNotifications();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("acts on the mail a notification was about, not on whatever was notified last", async () => {
    queueNewEmailNotification("Anna", "First", "t-first", "acc-1", "anna@example.org");
    await vi.advanceTimersByTimeAsync(2000);
    const first = plugin.sendNotification.mock.calls[0]![0];
    notifyFollowUpDue("Later", "t-later", "acc-1");

    // The user clicks the first notification after the second one arrived.
    await handler({ ...first, actionTypeId: "archive" });

    expect(actions.archiveThread).toHaveBeenCalledWith("acc-1", "t-first", []);
  });

  it("offers no per-mail actions on a notification that stands for several mails", async () => {
    queueNewEmailNotification("Anna", "One", "t1", "acc-1");
    queueNewEmailNotification("Bert", "Two", "t2", "acc-1");
    await vi.advanceTimersByTimeAsync(2000);

    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification.mock.calls[0]![0]).toMatchObject({ body: "2 new emails", actionTypeId: "default" });
  });
});
