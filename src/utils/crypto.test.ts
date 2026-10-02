import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockTauriFs } from "@/test/mocks";

const tauriFs = createMockTauriFs();
vi.mock("@tauri-apps/plugin-fs", () => tauriFs.mock);

// The OS keychain, as the credential_key_* commands expose it.
let keychain: string | null = null;
const mockInvoke = vi.fn(async (cmd: string, args?: { key: string }) => {
  if (cmd === "credential_key_get") return keychain;
  if (cmd === "credential_key_store") {
    if (keychain !== null) throw new Error("already stored");
    keychain = args!.key;
    return undefined;
  }
  throw new Error(`unexpected command ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

// Rows the database holds; crypto.ts reads them to check a key against stored data.
let accountRows: Record<string, string | null>[] = [];
let settingRows: { value: string | null }[] = [];
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string) => (sql.includes("FROM accounts") ? accountRows : settingRows)),
  })),
}));

const LEGACY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

/** Encrypt with the legacy key by seeding the file and running a first import. */
async function encryptWithKey(rawKeyB64: string, plaintext: string): Promise<string> {
  const raw = Uint8Array.from(atob(rawKeyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(7);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `${b64(iv)}:${b64(ct)}`;
}

describe("crypto", () => {
  beforeEach(() => {
    vi.resetModules();
    tauriFs.store.clear();
    vi.clearAllMocks();
    keychain = null;
    accountRows = [];
    settingRows = [];
  });

  it("encrypts and decrypts a value roundtrip", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    const plaintext = "my-secret-api-key-12345";
    const encrypted = await encryptValue(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(":")).toHaveLength(2);

    expect(await decryptValue(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const { encryptValue } = await import("./crypto");
    const enc1 = await encryptValue("same-value");
    const enc2 = await encryptValue("same-value");
    expect(enc1).not.toBe(enc2);
  });

  it("decryptValue throws on invalid format", async () => {
    const { decryptValue } = await import("./crypto");
    await expect(decryptValue("not-valid")).rejects.toThrow("Invalid encrypted value format");
  });

  it("isEncrypted returns true for encrypted values", async () => {
    const { encryptValue, isEncrypted } = await import("./crypto");
    expect(isEncrypted(await encryptValue("test"))).toBe(true);
  });

  it("isEncrypted returns false for plaintext", async () => {
    const { isEncrypted } = await import("./crypto");
    expect(isEncrypted("sk-ant-1234567890abcdef")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("just-a-regular-string")).toBe(false);
  });

  it("handles empty string encryption", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    expect(await decryptValue(await encryptValue(""))).toBe("");
  });

  it("handles unicode content", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    const plaintext = "Hello World! Emoji test";
    expect(await decryptValue(await encryptValue(plaintext))).toBe(plaintext);
  });

  describe("fresh install", () => {
    it("generates a key into the keychain and never writes a key file", async () => {
      const { encryptValue } = await import("./crypto");
      await encryptValue("test");

      expect(keychain).not.toBeNull();
      expect(atob(keychain!)).toHaveLength(32);
      expect(tauriFs.mock.writeTextFile).not.toHaveBeenCalled();
      expect(tauriFs.store.has("maish.key")).toBe(false);
    });

    it("reuses the keychain key on the next start", async () => {
      const first = await import("./crypto");
      const encrypted = await first.encryptValue("persisted");
      const stored = keychain;

      vi.resetModules();
      const second = await import("./crypto");
      expect(await second.decryptValue(encrypted)).toBe("persisted");
      expect(keychain).toBe(stored);
    });

    it("shares one key between concurrent first calls", async () => {
      const { encryptValue, decryptValue } = await import("./crypto");
      const [a, b] = await Promise.all([encryptValue("a"), encryptValue("b")]);
      expect(await decryptValue(a)).toBe("a");
      expect(await decryptValue(b)).toBe("b");
      expect(mockInvoke.mock.calls.filter(([c]) => c === "credential_key_store")).toHaveLength(1);
    });

    it("refuses to generate a key when encrypted credentials already exist", async () => {
      accountRows = [{ imap_password: await encryptWithKey(LEGACY_KEY, "pw"), access_token: null }];
      const { encryptValue } = await import("./crypto");

      await expect(encryptValue("x")).rejects.toThrow(/missing from the OS keychain/);
      expect(keychain).toBeNull();
    });
  });

  describe("migration from maish.key", () => {
    it("moves the key into the keychain, keeps decryption working and deletes the file", async () => {
      tauriFs.store.set("maish.key", `${LEGACY_KEY}\n`);
      const stored = await encryptWithKey(LEGACY_KEY, "imap-secret");
      accountRows = [{ imap_password: stored, access_token: null }];

      const { decryptValue } = await import("./crypto");
      expect(await decryptValue(stored)).toBe("imap-secret");

      expect(keychain).toBe(LEGACY_KEY);
      expect(tauriFs.store.has("maish.key")).toBe(false);
      expect(tauriFs.mock.remove).toHaveBeenCalledWith(
        "maish.key",
        expect.objectContaining({ baseDir: 26 }),
      );
    });

    it("also verifies against an encrypted setting", async () => {
      tauriFs.store.set("maish.key", LEGACY_KEY);
      settingRows = [{ value: await encryptWithKey(LEGACY_KEY, "sk-ant") }];

      const { encryptValue } = await import("./crypto");
      await encryptValue("x");

      expect(tauriFs.store.has("maish.key")).toBe(false);
    });

    it("keeps the file and throws when the key does not decrypt stored data", async () => {
      const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
      tauriFs.store.set("maish.key", LEGACY_KEY);
      accountRows = [{ imap_password: await encryptWithKey(otherKey, "pw") }];

      const { encryptValue } = await import("./crypto");
      await expect(encryptValue("x")).rejects.toThrow(/does not decrypt the stored credentials/);

      expect(tauriFs.store.has("maish.key")).toBe(true);
      expect(tauriFs.mock.remove).not.toHaveBeenCalled();
    });

    it("does not let a plaintext value that looks encrypted veto the key", async () => {
      tauriFs.store.set("maish.key", LEGACY_KEY);
      accountRows = [
        { access_token: "AAAAAAAAAAAAAAAA:AAAAAAAA", imap_password: await encryptWithKey(LEGACY_KEY, "pw") },
      ];

      const { encryptValue } = await import("./crypto");
      await encryptValue("x");

      expect(tauriFs.store.has("maish.key")).toBe(false);
    });

    it("never creates a new key while the file exists, even if the keychain write fails", async () => {
      tauriFs.store.set("maish.key", LEGACY_KEY);
      mockInvoke.mockImplementationOnce(async () => null); // get: nothing stored yet
      mockInvoke.mockImplementationOnce(async () => {
        throw new Error("keychain locked");
      });

      const { encryptValue } = await import("./crypto");
      await expect(encryptValue("x")).rejects.toThrow("keychain locked");

      expect(keychain).toBeNull();
      expect(tauriFs.store.get("maish.key")).toBe(LEGACY_KEY);
    });

    it("finishes an interrupted migration: key in the keychain and the file still there", async () => {
      keychain = LEGACY_KEY;
      tauriFs.store.set("maish.key", LEGACY_KEY);

      const { encryptValue } = await import("./crypto");
      await encryptValue("x");

      expect(tauriFs.store.has("maish.key")).toBe(false);
      expect(keychain).toBe(LEGACY_KEY);
    });

    it("leaves both untouched when keychain and file hold different keys", async () => {
      keychain = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
      tauriFs.store.set("maish.key", LEGACY_KEY);

      const { encryptValue } = await import("./crypto");
      await expect(encryptValue("x")).rejects.toThrow(/hold different credential keys/);

      expect(tauriFs.store.has("maish.key")).toBe(true);
    });

    it("rejects a key file that is not a 32-byte key", async () => {
      tauriFs.store.set("maish.key", btoa("short"));

      const { encryptValue } = await import("./crypto");
      await expect(encryptValue("x")).rejects.toThrow(/has 5 bytes, expected 32/);

      expect(keychain).toBeNull();
      expect(tauriFs.store.has("maish.key")).toBe(true);
    });
  });
});
