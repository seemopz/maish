export type AiProvider = "claude" | "openai" | "gemini" | "ollama";

export interface AiCompletionRequest {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
}

export interface AiProviderClient {
  complete(req: AiCompletionRequest): Promise<string>;
  testConnection(): Promise<boolean>;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: "claude-haiku-4-5-20251001",
  openai: "gpt-6-luna",
  gemini: "gemini-3.5-flash-lite",
  ollama: "llama3.2",
};

export interface ModelOption {
  id: string;
  label: string;
}

// Ids checked against the providers' model docs in October 2026. A saved id
// that drops out of this list falls back to the default (resolveModel).
export const PROVIDER_MODELS: Record<Exclude<AiProvider, "ollama">, ModelOption[]> = {
  claude: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  ],
  openai: [
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
  ],
  gemini: [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon" },
  ],
};

/** The saved model if the provider still offers it, otherwise the provider's default. */
export function resolveModel(
  provider: Exclude<AiProvider, "ollama">,
  saved: string | null | undefined,
): string {
  return saved && PROVIDER_MODELS[provider].some((m) => m.id === saved) ? saved : DEFAULT_MODELS[provider];
}

export const MODEL_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_model",
  openai: "openai_model",
  gemini: "gemini_model",
};
