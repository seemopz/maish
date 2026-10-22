import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();
const mockRetrieve = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function () {
    return { chat: { completions: { create: mockCreate } }, models: { retrieve: mockRetrieve } };
  });
  return { default: MockOpenAI };
});

import { createOpenAIProvider, clearOpenAIProvider } from "./openaiProvider";

describe("openaiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenAIProvider();
  });

  it("sends max_completion_tokens, which reasoning models require", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "Hello!" } }] });

    const result = await createOpenAIProvider("sk-test", "gpt-6-luna").complete({
      systemPrompt: "You are helpful",
      userContent: "Hi",
    });

    expect(result).toBe("Hello!");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "gpt-6-luna",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    });
  });

  it.each(["length", "content_filter"])("rejects a reply that finished with %s", async (finish_reason) => {
    mockCreate.mockResolvedValue({ choices: [{ finish_reason, message: { content: "" } }] });
    await expect(
      createOpenAIProvider("sk-test", "gpt-6-luna").complete({ systemPrompt: "s", userContent: "u" }),
    ).rejects.toThrow(finish_reason);
  });

  it("tests the connection by looking up the model", async () => {
    mockRetrieve.mockResolvedValue({ id: "gpt-6-luna" });
    expect(await createOpenAIProvider("sk-test", "gpt-6-luna").testConnection()).toBe(true);
    expect(mockRetrieve).toHaveBeenCalledWith("gpt-6-luna");
    expect(mockCreate).not.toHaveBeenCalled();

    mockRetrieve.mockRejectedValue(new Error("401"));
    expect(await createOpenAIProvider("sk-bad", "gpt-6-luna").testConnection()).toBe(false);
  });
});
