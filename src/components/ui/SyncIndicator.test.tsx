import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncIndicator } from "./SyncIndicator";
import { useUIStore } from "@/stores/uiStore";

beforeEach(() => {
  useUIStore.setState({ syncState: "idle", syncMessage: null });
});

describe("SyncIndicator", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<SyncIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a spinner with the progress text while syncing", () => {
    useUIStore.setState({ syncState: "syncing", syncMessage: "Syncing: 3/10 messages" });
    const { container } = render(<SyncIndicator />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("title")).toBe("Syncing: 3/10 messages");
    expect(el.textContent).toBe("Syncing: 3/10 messages");
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });

  it("keeps a failed sync visible with the error text", () => {
    useUIStore.setState({ syncState: "error", syncMessage: "Sync failed: timeout" });
    const { container } = render(<SyncIndicator />);
    const el = screen.getByRole("alert");
    expect(el.textContent).toBe("Sync failed: timeout");
    expect(el.className).toContain("text-danger");
    expect(container.querySelector("svg")?.getAttribute("class")).not.toContain("animate-spin");
  });
});
