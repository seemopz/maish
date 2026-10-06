import { render, screen, waitFor } from "@testing-library/react";
import { useUIStore } from "./stores/uiStore";

const settings = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock("./components/email/ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));
vi.mock("./components/composer/Composer", () => ({ Composer: () => null }));
vi.mock("./components/composer/UndoSendToast", () => ({ UndoSendToast: () => null }));
vi.mock("./components/ui/UndoActionToast", () => ({ UndoActionToast: () => null }));
vi.mock("./services/db/migrations", () => ({ runMigrations: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./services/db/accounts", () => ({ getAllAccounts: vi.fn().mockResolvedValue([]) }));
vi.mock("./services/db/settings", () => ({
  getSetting: vi.fn((key: string) => Promise.resolve(settings.values[key] ?? null)),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./services/gmail/tokenManager", () => ({ initializeClients: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./services/db/threads", () => ({
  getThreadLabelIds: vi.fn().mockResolvedValue([]),
  getThreadById: vi.fn().mockResolvedValue({
    id: "t1",
    account_id: "a1",
    subject: "Hi",
    snippet: "",
    last_message_at: 1,
    message_count: 1,
    is_read: 1,
    is_starred: 0,
    is_pinned: 0,
    is_muted: 0,
    has_attachments: 0,
    from_name: null,
    from_address: null,
  }),
}));

import ThreadWindow from "./ThreadWindow";

describe("ThreadWindow", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/?thread=t1&account=a1");
    // "system" would need matchMedia, which jsdom lacks
    useUIStore.setState({ mailZoom: 1, theme: "light" });
    settings.values = {};
  });

  it("restores the saved mail zoom", async () => {
    settings.values.mail_zoom = "1.5";
    render(<ThreadWindow />);
    await screen.findByTestId("thread-view");
    expect(useUIStore.getState().mailZoom).toBe(1.5);
  });

  it("keeps 100 % when no zoom was saved or the value is unusable", async () => {
    settings.values.mail_zoom = "abc";
    render(<ThreadWindow />);
    await waitFor(() => expect(screen.getByTestId("thread-view")).toBeTruthy());
    expect(useUIStore.getState().mailZoom).toBe(1);
  });
});
