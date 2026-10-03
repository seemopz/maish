import { getDb } from "./connection";
import { encryptValue, decryptValue, isEncrypted } from "@/utils/crypto";

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, value],
  );
}

/**
 * Get a setting that is stored encrypted. Transparently decrypts the value.
 * A value that is not in the encrypted format is returned as is (plaintext from
 * before encryption was introduced). An encrypted value that cannot be
 * decrypted is an error: returning the ciphertext would send it on as an API key.
 */
export async function getSecureSetting(key: string): Promise<string | null> {
  const raw = await getSetting(key);
  if (!raw) return null;

  if (isEncrypted(raw)) {
    try {
      return await decryptValue(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not decrypt the setting ${key}: ${reason}`);
    }
  }
  return raw;
}

/**
 * Set a setting with encryption. The value is encrypted before storing.
 */
export async function setSecureSetting(key: string, value: string): Promise<void> {
  const encrypted = await encryptValue(value);
  await setSetting(key, encrypted);
}
