import type { AiProviderClient, AiCompletionRequest } from "../types";

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
}

async function generateContent(
  apiKey: string,
  model: string,
  userContent: string,
  systemPrompt?: string,
): Promise<string> {
  const response = await fetch(`${MODELS_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
      contents: [{ role: "user", parts: [{ text: userContent }] }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as GenerateContentResponse;
  if (!data.candidates?.length) {
    throw new Error(`Gemini returned no text: ${data.promptFeedback?.blockReason ?? "no candidates"}`);
  }
  return (data.candidates[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

export function createGeminiProvider(apiKey: string, model: string): AiProviderClient {
  return {
    complete(req: AiCompletionRequest): Promise<string> {
      return generateContent(apiKey, model, req.userContent, req.systemPrompt);
    },

    async testConnection(): Promise<boolean> {
      try {
        await generateContent(apiKey, model, "Say hi");
        return true;
      } catch {
        return false;
      }
    },
  };
}
