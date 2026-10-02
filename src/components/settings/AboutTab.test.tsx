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

  it("links only to the project's own repository", async () => {
    render(<AboutTab />);
    const button = screen.getByRole("button", { name: /GitHub Repository/ });
    fireEvent.click(button);
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/seemopz/maish");
  });

  it("offers no website or contact row", () => {
    render(<AboutTab />);
    expect(screen.queryByText("Website")).toBeNull();
    expect(screen.queryByText("Contact")).toBeNull();
  });
});
