import OpenAI from "openai";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

// The GPT-6 models are reasoning models: they reject `max_tokens`, and the
// completion budget covers reasoning tokens as well as the visible answer.
const MAX_COMPLETION_TOKENS = 8192;
// Reasoning used up the budget or the reply was filtered; often with empty content.
const INCOMPLETE_FINISH_REASONS = ["length", "content_filter"];

const factory = createProviderFactory(
  (apiKey) => new OpenAI({ apiKey, dangerouslyAllowBrowser: true }),
);

export function createOpenAIProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userContent },
        ],
      });

      const choice = response.choices[0];
      if (choice && INCOMPLETE_FINISH_REASONS.includes(choice.finish_reason)) {
        throw new Error(`OpenAI stopped early (${choice.finish_reason}), the reply is incomplete`);
      }
      return choice?.message?.content ?? "";
    },

    async testConnection(): Promise<boolean> {
      try {
        // A 10-token reply can be cut off by reasoning; looking up the model checks key and id for free.
        await client.models.retrieve(model);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function clearOpenAIProvider(): void {
  factory.clear();
}
