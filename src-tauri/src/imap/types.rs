use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub security: String, // "tls", "starttls", "none"
    pub username: String,
    pub password: String,    // plaintext password or OAuth2 access token
    pub auth_method: String, // "password" or "oauth2"
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolder {
    pub path: String,     // decoded UTF-8 display name
    pub raw_path: String, // original modified UTF-7 path for IMAP commands
    pub name: String,     // decoded display name (last segment)
    pub delimiter: String,
    pub special_use: Option<String>, // "\Sent", "\Trash", "\Drafts", "\Junk", "\Archive", "\All"
    pub exists: u32,
    pub unseen: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapMessage {
    pub uid: u32,
    pub folder: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_draft: bool,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: Option<String>,
    pub raw_size: u32,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>,
    pub attachments: Vec<ImapAttachment>,
    /// Hex SHA-256 over the text part, the HTML part and every attachment
    /// (metadata and decoded bytes). Lets threading tell folder copies of one
    /// message from different mails that reuse its Message-ID. Independent of
    /// the MIME section numbers, which differ between folder copies.
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapAttachment {
    pub part_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u32,
    pub content_id: Option<String>,
    pub is_inline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolderStatus {
    pub uidvalidity: u32,
    pub uidnext: u32,
    pub exists: u32,
    pub unseen: u32,
    pub highest_modseq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFetchResult {
    pub messages: Vec<ImapMessage>,
    pub folder_status: ImapFolderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolderSearchResult {
    pub uids: Vec<u32>,
    pub folder_status: ImapFolderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaCheckRequest {
    pub folder: String,
    pub last_uid: u32,
    pub uidvalidity: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaCheckResult {
    pub folder: String,
    pub uidvalidity: u32,
    pub new_uids: Vec<u32>,
    pub uidvalidity_changed: bool,
    /// Set when SELECT or UID SEARCH failed for this folder: `new_uids` is then
    /// empty because the folder was not checked, not because it has nothing new.
    #[serde(default)]
    pub error: Option<String>,
}

impl DeltaCheckResult {
    /// Result for a folder that could not be checked.
    pub fn failed(req: &DeltaCheckRequest, error: String) -> Self {
        Self {
            folder: req.folder.clone(),
            uidvalidity: req.uidvalidity,
            new_uids: vec![],
            uidvalidity_changed: false,
            error: Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_delta_check_carries_the_error_and_no_uids() {
        let req = DeltaCheckRequest {
            folder: "Archive".into(),
            last_uid: 4,
            uidvalidity: 7,
        };
        let res = DeltaCheckResult::failed(&req, "SELECT failed: nope".into());
        assert_eq!(res.folder, "Archive");
        assert!(res.new_uids.is_empty());
        assert!(!res.uidvalidity_changed);
        assert_eq!(res.error.as_deref(), Some("SELECT failed: nope"));
    }

    #[test]
    fn delta_check_result_without_error_field_deserialises() {
        let res: DeltaCheckResult = serde_json::from_str(
            r#"{"folder":"INBOX","uidvalidity":1,"new_uids":[],"uidvalidity_changed":false}"#,
        )
        .unwrap();
        assert!(res.error.is_none());
    }
}
