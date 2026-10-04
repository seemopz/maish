import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri plugins
const mockCheck = vi.fn();
const mockRelaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));

const mockLogToFile = vi.fn();
vi.mock("./logFile", () => ({
  logToFile: (...args: unknown[]) => mockLogToFile(...args),
}));

import {
  checkForUpdateNow,
  installUpdate,
  getAvailableUpdate,
  setUpdateCallback,
  updateProgressLabel,
  _resetForTesting,
} from "./updateManager";

beforeEach(() => {
  _resetForTesting();
  mockCheck.mockReset();
  mockRelaunch.mockReset();
  mockLogToFile.mockReset();
});

describe("updateManager", () => {
  it("returns null when no update is available", async () => {
    mockCheck.mockResolvedValue(null);
    const result = await checkForUpdateNow();
    expect(result).toBeNull();
    expect(getAvailableUpdate()).toBeNull();
  });

  it("returns update info when an update is available", async () => {
    mockCheck.mockResolvedValue({
      version: "1.2.3",
      body: "Bug fixes",
      downloadAndInstall: vi.fn(),
    });

    const result = await checkForUpdateNow();
    expect(result).toEqual({ version: "1.2.3", body: "Bug fixes" });
    expect(getAvailableUpdate()).toEqual({ version: "1.2.3", body: "Bug fixes" });
  });

  it("invokes callback when update is found", async () => {
    const cb = vi.fn();
    setUpdateCallback(cb);

    mockCheck.mockResolvedValue({
      version: "2.0.0",
      body: null,
      downloadAndInstall: vi.fn(),
    });

    await checkForUpdateNow();
    expect(cb).toHaveBeenCalledWith({ version: "2.0.0", body: null });
  });

  it("installUpdate calls downloadAndInstall and relaunch", async () => {
    const mockDownloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mockCheck.mockResolvedValue({
      version: "1.0.1",
      body: null,
      downloadAndInstall: mockDownloadAndInstall,
    });
    mockRelaunch.mockResolvedValue(undefined);

    await checkForUpdateNow();
    await installUpdate();

    expect(mockDownloadAndInstall).toHaveBeenCalled();
    expect(mockRelaunch).toHaveBeenCalled();
  });

  it("installUpdate reports download progress, then installing and restarting", async () => {
    mockCheck.mockResolvedValue({
      version: "1.0.1",
      body: null,
      downloadAndInstall: vi.fn(async (onEvent: (e: unknown) => void) => {
        onEvent({ event: "Started", data: { contentLength: 200 } });
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
        onEvent({ event: "Progress", data: { chunkLength: 150 } });
        onEvent({ event: "Finished" });
      }),
    });
    mockRelaunch.mockResolvedValue(undefined);
    const onProgress = vi.fn();

    await checkForUpdateNow();
    await installUpdate(onProgress);

    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      { phase: "downloading", percent: 0 },
      { phase: "downloading", percent: 25 },
      { phase: "downloading", percent: 100 },
      { phase: "installing" },
      { phase: "restarting" },
    ]);
  });

  it("installUpdate reports no percentage when the size is unknown", async () => {
    mockCheck.mockResolvedValue({
      version: "1.0.1",
      body: null,
      downloadAndInstall: vi.fn(async (onEvent: (e: unknown) => void) => {
        onEvent({ event: "Started", data: {} });
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
      }),
    });
    const onProgress = vi.fn();

    await checkForUpdateNow();
    await installUpdate(onProgress);

    expect(onProgress).toHaveBeenNthCalledWith(1, { phase: "downloading", percent: null });
    expect(onProgress).toHaveBeenNthCalledWith(2, { phase: "downloading", percent: null });
  });

  it("installUpdate logs a failed download to the log file and rethrows", async () => {
    mockCheck.mockResolvedValue({
      version: "1.0.1",
      body: null,
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("signature mismatch")),
    });

    await checkForUpdateNow();
    await expect(installUpdate()).rejects.toThrow("signature mismatch");
    expect(mockLogToFile).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("signature mismatch"),
    );
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("updateProgressLabel describes each phase", () => {
    expect(updateProgressLabel({ phase: "downloading", percent: 42 })).toBe("Downloading 42%");
    expect(updateProgressLabel({ phase: "downloading", percent: null })).toBe("Downloading...");
    expect(updateProgressLabel({ phase: "installing" })).toBe("Installing...");
    expect(updateProgressLabel({ phase: "restarting" })).toBe("Restarting...");
  });

  it("installUpdate throws if no update available", async () => {
    await expect(installUpdate()).rejects.toThrow("No update available");
  });

  it("_resetForTesting clears state", async () => {
    mockCheck.mockResolvedValue({
      version: "3.0.0",
      body: "New features",
      downloadAndInstall: vi.fn(),
    });
    await checkForUpdateNow();
    expect(getAvailableUpdate()).not.toBeNull();

    _resetForTesting();
    expect(getAvailableUpdate()).toBeNull();
  });
});
