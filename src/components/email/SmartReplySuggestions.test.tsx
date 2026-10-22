import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mockGenerate = vi.fn();
vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: () => Promise.resolve(true),
}));
vi.mock("@/services/ai/aiService", () => ({
  generateSmartReplies: (...args: unknown[]) => mockGenerate(...args),
  SMART_REPLIES_CACHE: "smart_replies_v2",
}));
vi.mock("@/services/db/aiCache", () => ({
  deleteAiCache: vi.fn(),
}));

import { SmartReplySuggestions } from "./SmartReplySuggestions";
import type { DbMessage } from "@/services/db/messages";

const messages = [{ id: "m1", thread_id: "t1", subject: "Druck", from_address: "anna@example.de" }] as unknown as DbMessage[];

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("SmartReplySuggestions", () => {
  it("shows the replies the model returned", async () => {
    mockGenerate.mockResolvedValue(["Mach ich!", "Gerne."]);
    render(<SmartReplySuggestions threadId="t1" accountId="a1" messages={messages} />);
    expect(await screen.findByRole("button", { name: "Mach ich!" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gerne." })).toBeTruthy();
  });

  it("shows no card when no reply is left", async () => {
    mockGenerate.mockResolvedValue([]);
    const { container } = render(<SmartReplySuggestions threadId="t1" accountId="a1" messages={messages} />);
    await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
