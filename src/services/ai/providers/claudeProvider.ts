import type { AiProviderClient, AiCompletionRequest } from "../types";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

async function createMessage(apiKey: string, body: object): Promise<string> {
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calls from a webview; the key is the user's own.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Claude API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

export function createClaudeProvider(apiKey: string, model: string): AiProviderClient {
  return {
    complete(req: AiCompletionRequest): Promise<string> {
      return createMessage(apiKey, {
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userContent }],
      });
    },

    async testConnection(): Promise<boolean> {
      try {
        await createMessage(apiKey, {
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
