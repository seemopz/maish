import { render, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const { getSetting, getSecureSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(),
  getSecureSetting: vi.fn(),
}));

vi.mock("@/services/db/settings", () => ({
  getSetting,
  setSetting: vi.fn(),
  getSecureSetting,
  setSecureSetting: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ tab: "general" }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.2.3") }));

import { SettingsPage } from "./SettingsPage";

describe("SettingsPage load", () => {
  beforeEach(() => {
    getSetting.mockReset().mockResolvedValue(null);
    getSecureSetting.mockReset().mockResolvedValue(null);
  });

  it("keeps loading the remaining settings when a secure setting cannot be decrypted", async () => {
    getSecureSetting.mockImplementation(async (key: string) => {
      if (key === "google_client_secret") {
        throw new Error("Could not decrypt the setting google_client_secret: key missing");
      }
      return null;
    });

    render(<SettingsPage />);

    // "ai_writing_style_enabled" is read near the end of load(), after every secure setting.
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith("ai_writing_style_enabled"));
    // Each secure setting is read on its own, so one bad one does not hide the others.
    expect(getSecureSetting).toHaveBeenCalledWith("claude_api_key");
    expect(getSecureSetting).toHaveBeenCalledWith("copilot_api_key");
  });
});
