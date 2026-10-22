import type { AiProviderClient, AiCompletionRequest } from "../types";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 60_000;
// Opus 5.5 and Fable 5.1 always think, Sonnet 5.5 by default; max_tokens covers thinking and answer.
const MAX_TOKENS = 8192;
// The reply is cut off or withheld; caching it would show half a summary or an empty one.
const INCOMPLETE_STOP_REASONS = ["max_tokens", "refusal"];

interface ClaudeReply {
  text: string;
  stopReason?: string;
}

async function createMessage(apiKey: string, body: object): Promise<ClaudeReply> {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Claude API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  return {
    text: data.content?.find((b) => b.type === "text")?.text ?? "",
    stopReason: data.stop_reason,
  };
}

export function createClaudeProvider(apiKey: string, model: string): AiProviderClient {
  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const { text, stopReason } = await createMessage(apiKey, {
        model,
        max_tokens: req.maxTokens ?? MAX_TOKENS,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userContent }],
      });
      if (stopReason && INCOMPLETE_STOP_REASONS.includes(stopReason)) {
        throw new Error(`Claude stopped early (${stopReason}), the reply is incomplete`);
      }
      return text;
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
