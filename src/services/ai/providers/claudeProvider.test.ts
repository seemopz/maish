import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClaudeProvider } from "./claudeProvider";

const mockFetch = vi.fn();

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("claudeProvider", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("posts the system prompt and user content with the API key header", async () => {
    mockFetch.mockResolvedValue(ok({ content: [{ type: "text", text: "Hello!" }] }));

    const result = await createClaudeProvider("sk-ant-test", "claude-haiku-4-5-20251001").complete({
      systemPrompt: "You are helpful",
      userContent: "Hi",
    });

    expect(result).toBe("Hello!");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(init.body)).toEqual({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("honours maxTokens and skips non-text blocks", async () => {
    mockFetch.mockResolvedValue(ok({ content: [{ type: "tool_use" }, { type: "text", text: "ok" }] }));

    const result = await createClaudeProvider("k", "m").complete({
      systemPrompt: "s",
      userContent: "u",
      maxTokens: 50,
    });

    expect(result).toBe("ok");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).max_tokens).toBe(50);
  });

  it("returns an empty string when the reply has no text block", async () => {
    mockFetch.mockResolvedValue(ok({ content: [] }));
    expect(await createClaudeProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" })).toBe("");
  });

  it("aborts a request after a timeout", async () => {
    mockFetch.mockResolvedValue(ok({ content: [{ type: "text", text: "x" }] }));
    await createClaudeProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" });
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws with the status when the API answers with an error", async () => {
    mockFetch.mockResolvedValue(new Response("invalid x-api-key", { status: 401 }));
    await expect(
      createClaudeProvider("bad", "m").complete({ systemPrompt: "s", userContent: "u" }),
    ).rejects.toThrow("Claude API error 401");
  });

  it("testConnection is true on success and false on failure", async () => {
    mockFetch.mockResolvedValueOnce(ok({ content: [{ type: "text", text: "hi" }] }));
    expect(await createClaudeProvider("k", "m").testConnection()).toBe(true);

    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    expect(await createClaudeProvider("k", "m").testConnection()).toBe(false);

    mockFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await createClaudeProvider("k", "m").testConnection()).toBe(false);
  });
});
