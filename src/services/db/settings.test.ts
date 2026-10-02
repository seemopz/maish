import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();

vi.mock("./connection", () => ({
  getDb: vi.fn(() => ({ select: (...args: unknown[]) => mockSelect(...args), execute: vi.fn() })),
}));

vi.mock("@/utils/crypto", () => ({
  encryptValue: vi.fn((val: string) => Promise.resolve(`enc:${val}`)),
  decryptValue: vi.fn((val: string) => Promise.resolve(val.replace("enc:", ""))),
  isEncrypted: vi.fn((val: string) => val.startsWith("enc:")),
}));

import { decryptValue } from "@/utils/crypto";
import { getSecureSetting } from "./settings";

describe("getSecureSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decrypts an encrypted value", async () => {
    mockSelect.mockResolvedValue([{ value: "enc:sk-123" }]);
    expect(await getSecureSetting("claude_api_key")).toBe("sk-123");
  });

  it("returns a plaintext value from before encryption was introduced", async () => {
    mockSelect.mockResolvedValue([{ value: "sk-plain" }]);
    expect(await getSecureSetting("claude_api_key")).toBe("sk-plain");
  });

  it("throws instead of returning ciphertext when an encrypted value cannot be decrypted", async () => {
    mockSelect.mockResolvedValue([{ value: "enc:sk-123" }]);
    vi.mocked(decryptValue).mockRejectedValueOnce(new Error("key missing"));

    await expect(getSecureSetting("claude_api_key")).rejects.toThrow(
      /Could not decrypt the setting claude_api_key: key missing/,
    );
  });
});
