import { createBackgroundChecker } from "./backgroundCheckers";
import type { BackgroundChecker } from "./backgroundCheckers";
import { logToFile } from "./logFile";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

interface UpdateInfo {
  version: string;
  body: string | null;
}

type UpdateCallback = (update: UpdateInfo) => void;

/** `percent` is null when the server sends no Content-Length. */
export type UpdateProgress =
  | { phase: "downloading"; percent: number | null }
  | { phase: "installing" }
  | { phase: "restarting" };

let checker: BackgroundChecker | null = null;
let availableUpdate: { info: UpdateInfo; raw: unknown } | null = null;
let callback: UpdateCallback | null = null;

async function performCheck(): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (update) {
    availableUpdate = {
      info: { version: update.version, body: update.body ?? null },
      raw: update,
    };
    callback?.(availableUpdate.info);
  }
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;

export function startUpdateChecker(): void {
  if (checker) return;
  checker = createBackgroundChecker("update-checker", performCheck, FOUR_HOURS);
  checker.start();
}

export function stopUpdateChecker(): void {
  checker?.stop();
  checker = null;
}

export async function checkForUpdateNow(): Promise<UpdateInfo | null> {
  await performCheck();
  return availableUpdate?.info ?? null;
}

export async function installUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  if (!availableUpdate) throw new Error("No update available");
  const update = availableUpdate.raw as {
    downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
  };
  const version = availableUpdate.info.version;
  let total: number | null = null;
  let received = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength || null;
        onProgress?.({ phase: "downloading", percent: total ? 0 : null });
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        onProgress?.({
          phase: "downloading",
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        });
      } else {
        onProgress?.({ phase: "installing" });
      }
    });
  } catch (err) {
    logToFile("error", `Update to v${version} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  onProgress?.({ phase: "restarting" });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export function updateProgressLabel(progress: UpdateProgress): string {
  switch (progress.phase) {
    case "downloading":
      return progress.percent === null ? "Downloading..." : `Downloading ${progress.percent}%`;
    case "installing":
      return "Installing...";
    case "restarting":
      return "Restarting...";
  }
}

export function getAvailableUpdate(): UpdateInfo | null {
  return availableUpdate?.info ?? null;
}

export function setUpdateCallback(cb: UpdateCallback | null): void {
  callback = cb;
}

/** Reset module state for testing */
export function _resetForTesting(): void {
  checker?.stop();
  checker = null;
  availableUpdate = null;
  callback = null;
}
