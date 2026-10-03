import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeUnsubscribe } from "./unsubscribeManager";

const mockFetch = vi.fn();
const mockOpenUrl = vi.fn();
const mockExecute = vi.fn();

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

vi.mock("../db/connection", () => ({
  getDb: vi.fn(() => ({ execute: (...args: unknown[]) => mockExecute(...args) })),
}));

const ONE_CLICK = "List-Unsubscribe=One-Click";

function run(listUnsubscribe: string, post: string | null = ONE_CLICK) {
  return executeUnsubscribe("acc-1", "thread-1", "news@example.com", null, listUnsubscribe, post);
}

describe("executeUnsubscribe one-click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockOpenUrl.mockResolvedValue(undefined);
  });

  it("posts to an https URL without following redirects", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await run("<https://example.com/u>");

    expect(result).toEqual({ method: "http_post", success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/u",
      expect.objectContaining({ method: "POST", maxRedirections: 0 }),
    );
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it.each([
    "<http://example.com/u>",
    "<http://localhost:8080/u>",
    "<http://127.0.0.1:8080/u>",
  ])("never posts to a plain http URL (%s)", async (header) => {
    const result = await run(header);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ method: "browser", success: true });
    expect(mockOpenUrl).toHaveBeenCalledTimes(1);
  });

  it("treats a redirect answer as a failure and falls back to the browser", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 307 });

    const result = await run("<https://example.com/u>");

    expect(result).toEqual({ method: "browser", success: true });
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/u");
  });

  it("falls back when the request throws", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run("<https://example.com/u>");

    expect(result).toEqual({ method: "browser", success: true });
  });
});
