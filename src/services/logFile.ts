import { invoke } from "@tauri-apps/api/core";

/**
 * Write a line to the log file. `console.*` stays in the webview and never
 * reaches it, so anything worth diagnosing after the fact goes through here.
 * Never throws: logging must not turn a failure into a second one.
 */
export function logToFile(level: "info" | "warn" | "error", message: string): void {
  invoke("log_frontend", { level, message }).catch(() => {});
}
