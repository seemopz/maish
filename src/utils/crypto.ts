/**
 * Application-level AES-GCM encryption using a device-bound key.
 * The key is a random AES-256 key held in the OS keychain (macOS Keychain,
 * Windows Credential Manager, Secret Service on Linux) through the
 * `credential_key_*` commands in `src-tauri/src/credential_key.rs`.
 *
 * Installs from before the keychain kept the key in `maish.key` next to the
 * database. That file is moved into the keychain on first use and deleted once
 * the stored credentials are shown to decrypt with the moved key.
 */

import { invoke } from "@tauri-apps/api/core";
import { exists, readTextFile, remove, BaseDirectory } from "@tauri-apps/plugin-fs";

const LEGACY_KEY_FILE_NAME = "maish.key";
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const FS_OPTIONS = { baseDir: BaseDirectory.AppData };

let keyPromise: Promise<CryptoKey> | null = null;

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Web Crypto API accepts BufferSource (ArrayBuffer | ArrayBufferView).
// TypeScript's ES2021 lib types are strict about Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>.
// This cast satisfies the type checker while passing the Uint8Array directly to the API.
function asBufferSource(arr: Uint8Array): BufferSource {
  return arr as unknown as BufferSource;
}

async function importKey(rawKeyB64: string): Promise<CryptoKey> {
  let rawKey: Uint8Array;
  try {
    rawKey = base64Decode(rawKeyB64);
  } catch {
    throw new Error("The credential encryption key is not valid base64");
  }
  if (rawKey.length !== KEY_LENGTH / 8) {
    throw new Error(
      `The credential encryption key has ${rawKey.length} bytes, expected ${KEY_LENGTH / 8}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    asBufferSource(rawKey),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );
}

async function readLegacyKey(): Promise<string | null> {
  if (!(await exists(LEGACY_KEY_FILE_NAME, FS_OPTIONS))) return null;
  return (await readTextFile(LEGACY_KEY_FILE_NAME, FS_OPTIONS)).trim();
}

/**
 * Every stored value that looks encrypted. They are the only way to tell
 * whether a key is the one the data was written with: GCM authenticates, so a
 * wrong key fails instead of producing garbage.
 */
async function storedCiphertexts(): Promise<string[]> {
  // Imported on demand: the db modules import this one.
  const { getDb } = await import("@/services/db/connection");
  const db = await getDb();
  const accountRows = await db.select<Record<string, string | null>[]>(
    `SELECT access_token, refresh_token, imap_password, oauth_client_secret,
            caldav_password, carddav_password FROM accounts`,
  );
  const settingRows = await db.select<{ value: string | null }[]>(
    "SELECT value FROM settings",
  );
  const values = [
    ...accountRows.flatMap((row) => Object.values(row)),
    ...settingRows.map((row) => row.value),
  ];
  return values.filter((v): v is string => typeof v === "string" && isEncrypted(v));
}

async function decryptWith(key: CryptoKey, encrypted: string): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted value format");
  }
  const [ivB64, ciphertextB64] = parts;
  if (!ivB64 || !ciphertextB64) {
    throw new Error("Invalid encrypted value format");
  }

  const iv = base64Decode(ivB64);
  const ciphertext = base64Decode(ciphertextB64);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

/** True when there is nothing stored to check against, or the key opens one of the values. */
async function keyMatchesStoredData(key: CryptoKey): Promise<boolean> {
  const samples = await storedCiphertexts();
  if (samples.length === 0) return true;
  for (const sample of samples) {
    try {
      await decryptWith(key, sample);
      return true;
    } catch {
      // try the next one; a value that merely looks encrypted must not veto the key
    }
  }
  return false;
}

/** Delete maish.key, but only once the key is known to open the stored credentials. */
async function retireLegacyFile(key: CryptoKey): Promise<void> {
  if (!(await keyMatchesStoredData(key))) {
    throw new Error(
      `The credential key in ${LEGACY_KEY_FILE_NAME} does not decrypt the stored credentials; the file was left in place`,
    );
  }
  await remove(LEGACY_KEY_FILE_NAME, FS_OPTIONS);
}

async function loadKey(): Promise<CryptoKey> {
  const stored = await invoke<string | null>("credential_key_get");
  const legacy = await readLegacyKey();

  if (stored) {
    const key = await importKey(stored);
    if (legacy !== null) {
      // A previous run stored the key and was interrupted before deleting the file.
      if (legacy !== stored) {
        throw new Error(
          `The OS keychain and ${LEGACY_KEY_FILE_NAME} hold different credential keys; neither was changed`,
        );
      }
      await retireLegacyFile(key);
    }
    return key;
  }

  if (legacy !== null) {
    const key = await importKey(legacy);
    await invoke("credential_key_store", { key: legacy });
    if ((await invoke<string | null>("credential_key_get")) !== legacy) {
      throw new Error("The credential key could not be read back from the OS keychain");
    }
    await retireLegacyFile(key);
    return key;
  }

  // No key anywhere. Generating one is only safe if nothing was encrypted with the lost one.
  if ((await storedCiphertexts()).length > 0) {
    throw new Error(
      "The credential encryption key is missing from the OS keychain while encrypted credentials are stored. " +
        "A new key would make them unreadable, so none was created. " +
        "Restore the key (or maish.key) or remove and re-add the accounts.",
    );
  }
  const rawKey = new Uint8Array(KEY_LENGTH / 8);
  crypto.getRandomValues(rawKey);
  const rawKeyB64 = base64Encode(rawKey);
  await invoke("credential_key_store", { key: rawKeyB64 });
  if ((await invoke<string | null>("credential_key_get")) !== rawKeyB64) {
    throw new Error("The credential key could not be read back from the OS keychain");
  }
  return importKey(rawKeyB64);
}

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = loadKey().catch((err) => {
      keyPromise = null;
      throw err;
    });
  }
  return keyPromise;
}

/**
 * Encrypt a plaintext string. Returns a base64 string in the format: iv:ciphertext
 * (GCM tag is appended to ciphertext by the Web Crypto API)
 */
export async function encryptValue(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(data),
  );

  const ivB64 = base64Encode(iv);
  const ciphertextB64 = base64Encode(new Uint8Array(encrypted));
  return `${ivB64}:${ciphertextB64}`;
}

/**
 * Decrypt a value produced by encryptValue. Returns the original plaintext.
 */
export async function decryptValue(encrypted: string): Promise<string> {
  const key = await getKey();
  return decryptWith(key, encrypted);
}

/**
 * Check if a value looks like it's already encrypted (base64:base64 format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  try {
    atob(parts[0]!);
    atob(parts[1]!);
    // Encrypted values have a 12-byte IV (16 chars base64) and substantial ciphertext
    return parts[0]!.length === 16;
  } catch {
    return false;
  }
}
