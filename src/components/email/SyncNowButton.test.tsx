import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockTriggerSync = vi.fn();
vi.mock("@/services/gmail/syncManager", () => ({
  triggerSync: (ids: string[]) => mockTriggerSync(ids),
}));
vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));

import { SyncNowButton } from "./SyncNowButton";
import { useAccountStore, type Account } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";

beforeEach(() => {
  mockTriggerSync.mockReset();
  useAccountStore.setState({ activeAccountId: "a1" });
  useUIStore.setState({ syncState: "idle", syncMessage: null, isSyncingFolder: null });
});

describe("SyncNowButton", () => {
  it("is labelled for assistive tech and has a tooltip", () => {
    render(<SyncNowButton />);
    const btn = screen.getByRole("button", { name: "Sync now" });
    expect(btn.getAttribute("title")).toBe("Sync now");
  });

  it("triggers a sync for the active account and marks the folder as syncing", () => {
    render(<SyncNowButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(mockTriggerSync).toHaveBeenCalledWith(["a1"]);
    expect(useUIStore.getState().isSyncingFolder).toBe("inbox");
  });

  it("is disabled and spins while a sync is running", () => {
    useUIStore.setState({ syncState: "syncing" });
    const { container } = render(<SyncNowButton />);
    const btn = screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    fireEvent.click(btn);
    expect(mockTriggerSync).not.toHaveBeenCalled();
  });

  it("is disabled without an active account", () => {
    useAccountStore.setState({ activeAccountId: null });
    render(<SyncNowButton />);
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a failed sync visible in red with the error as tooltip", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    render(<SyncNowButton />);
    const btn = screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("title")).toBe("Sync failed: timeout – Sync now");
    expect(btn.className).toContain("text-danger");
  });

  it("syncs all active accounts after a failure, which may belong to another account", () => {
    const account = (id: string, isActive: boolean): Account =>
      ({ id, email: `${id}@example.com`, displayName: null, avatarUrl: null, isActive });
    useAccountStore.setState({ accounts: [account("a1", true), account("a2", false), account("a3", true)] });
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    render(<SyncNowButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(mockTriggerSync).toHaveBeenCalledWith(["a1", "a3"]);
  });
});
