import { describe, it, expect, beforeEach, vi } from "vitest";
import { createGeminiProvider } from "./geminiProvider";

const mockFetch = vi.fn();

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("geminiProvider", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("posts the system instruction and user content, key in a header not the URL", async () => {
    mockFetch.mockResolvedValue(ok({ candidates: [{ content: { parts: [{ text: "Hello!" }] } }] }));

    const result = await createGeminiProvider("gkey", "gemini-2.5-flash").complete({
      systemPrompt: "You are helpful",
      userContent: "Hi",
    });

    expect(result).toBe("Hello!");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("gkey");
    expect(JSON.parse(init.body)).toEqual({
      systemInstruction: { parts: [{ text: "You are helpful" }] },
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });
  });

  it("joins the text parts of the first candidate", async () => {
    mockFetch.mockResolvedValue(
      ok({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }, { content: { parts: [{ text: "x" }] } }] }),
    );
    expect(await createGeminiProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" })).toBe("ab");
  });

  it("throws the block reason when there are no candidates", async () => {
    mockFetch.mockResolvedValue(ok({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(
      createGeminiProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" }),
    ).rejects.toThrow("SAFETY");
  });

  it.each(["SAFETY", "RECITATION", "LANGUAGE"])("throws when the reply was withheld for %s", async (reason) => {
    mockFetch.mockResolvedValue(ok({ candidates: [{ finishReason: reason, content: { parts: [{ text: "cut" }] } }] }));
    await expect(
      createGeminiProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" }),
    ).rejects.toThrow(reason);
  });

  it("accepts a normal STOP and MAX_TOKENS finish", async () => {
    mockFetch.mockResolvedValue(ok({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }] }));
    expect(await createGeminiProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" })).toBe("partial");
  });

  it("aborts a request after a timeout", async () => {
    mockFetch.mockResolvedValue(ok({ candidates: [{ content: { parts: [{ text: "x" }] } }] }));
    await createGeminiProvider("k", "m").complete({ systemPrompt: "s", userContent: "u" });
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws with the status when the API answers with an error", async () => {
    mockFetch.mockResolvedValue(new Response("API key not valid", { status: 400 }));
    await expect(
      createGeminiProvider("bad", "m").complete({ systemPrompt: "s", userContent: "u" }),
    ).rejects.toThrow("Gemini API error 400");
  });

  it("testConnection sends no system instruction and reports success or failure", async () => {
    mockFetch.mockResolvedValueOnce(ok({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }));
    expect(await createGeminiProvider("k", "m").testConnection()).toBe(true);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      contents: [{ role: "user", parts: [{ text: "Say hi" }] }],
    });

    mockFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await createGeminiProvider("k", "m").testConnection()).toBe(false);
  });
});
