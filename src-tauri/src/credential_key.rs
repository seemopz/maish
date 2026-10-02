//! The AES key that protects stored credentials, kept in the OS keychain
//! (macOS Keychain, Windows Credential Manager, Secret Service on Linux).
//!
//! The webview gets exactly two operations: read the key, and store it when none
//! exists yet. Replacing or deleting it is deliberately not exposed: losing the
//! key makes every stored credential unreadable.

use keyring::{Entry, Error};

const SERVICE: &str = "xyz.hochreiner.maish";
const ACCOUNT: &str = "credential-encryption-key";

/// A base64-encoded 32-byte key is 44 characters, the last being padding.
const KEY_B64_LEN: usize = 44;

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("OS keychain unavailable: {e}"))
}

fn validate_key(key: &str) -> Result<(), String> {
    let well_formed = key.len() == KEY_B64_LEN
        && key.ends_with('=')
        && key
            .bytes()
            .take(KEY_B64_LEN - 1)
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
    if well_formed {
        Ok(())
    } else {
        Err("credential key must be a base64-encoded 32-byte value".to_string())
    }
}

fn read_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the credential key from the OS keychain: {e}")),
    }
}

fn store_key(key: &str) -> Result<(), String> {
    validate_key(key)?;
    let entry = entry()?;
    match entry.get_password() {
        Ok(_) => {
            return Err("a credential key is already stored in the OS keychain".to_string());
        }
        Err(Error::NoEntry) => {}
        Err(e) => {
            return Err(format!(
                "could not check the OS keychain for an existing credential key: {e}"
            ));
        }
    }
    entry
        .set_password(key)
        .map_err(|e| format!("could not store the credential key in the OS keychain: {e}"))
}

// Keychain calls can block (a locked keychain waits for the user), so they run
// off the thread that serves the webview.

/// Returns the stored key, or `None` if the keychain has none.
#[tauri::command]
pub async fn credential_key_get() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(read_key)
        .await
        .map_err(|e| e.to_string())?
}

/// Stores `key`; fails if a key is already stored rather than replacing it.
#[tauri::command]
pub async fn credential_key_store(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store_key(&key))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::validate_key;

    #[test]
    fn accepts_a_base64_32_byte_key() {
        assert!(validate_key("KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=").is_ok());
    }

    #[test]
    fn rejects_other_lengths_and_alphabets() {
        assert!(validate_key("").is_err());
        assert!(validate_key("c2hvcnQ=").is_err());
        assert!(validate_key("KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio").is_err());
        assert!(validate_key("Kioq!ioqKioqKioqKioqKioqKioqKioqKioqKioqKio=").is_err());
    }
}
