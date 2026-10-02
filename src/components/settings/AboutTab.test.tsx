import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.2.3") }));

import { AboutTab } from "./SettingsPage";

describe("AboutTab", () => {
  beforeEach(() => {
    openUrl.mockClear();
  });

  it("opens the project's own repository", async () => {
    render(<AboutTab />);
    fireEvent.click(screen.getByRole("button", { name: /GitHub Repository/ }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/seemopz/maish");
  });

  it("only links to the repository and the licence text", async () => {
    render(<AboutTab />);
    const buttons = screen.getAllByRole("button");
    for (const [i, button] of buttons.entries()) {
      fireEvent.click(button);
      await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(i + 1));
    }
    for (const [url] of openUrl.mock.calls) {
      expect(url).toMatch(/^https:\/\/(github\.com\/seemopz\/maish|www\.apache\.org\/)/);
    }
  });

  it("offers no website or contact row", () => {
    render(<AboutTab />);
    expect(screen.queryByText("Website")).toBeNull();
    expect(screen.queryByText("Contact")).toBeNull();
  });
});
