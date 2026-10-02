use async_imap::{types::Flag, Authenticator, Client, Session};
use base64::Engine;
use futures::StreamExt;
use mail_parser::{MessageParser, MimeHeaders};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

use super::types::*;

// ---------- Timeout constants ----------

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const IMAP_SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
const OVERALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// Configure TCP keepalive and nodelay on a connected socket.
fn configure_tcp_socket(stream: &TcpStream) {
    // Set TCP nodelay via tokio's built-in API
    if let Err(e) = stream.set_nodelay(true) {
        log::warn!("Failed to set TCP_NODELAY: {e}");
    }

    // Set TCP keepalive via socket2
    let sock_ref = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(60));
    if let Err(e) = sock_ref.set_tcp_keepalive(&keepalive) {
        log::warn!("Failed to set TCP keepalive: {e}");
    }
}

// ---------- XOAUTH2 authenticator ----------

struct XOAuth2 {
    response: Vec<u8>,
}

impl XOAuth2 {
    fn new(user: &str, access_token: &str) -> Self {
        // XOAUTH2 format: "user=" {user} "\x01auth=Bearer " {token} "\x01\x01"
        let s = format!("user={}\x01auth=Bearer {}\x01\x01", user, access_token);
        Self {
            response: s.into_bytes(),
        }
    }
}

impl Authenticator for XOAuth2 {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        // Return the initial XOAUTH2 string on the first (empty) challenge.
        // If the server sends a second challenge it means auth failed; we send
        // an empty response to let the server return a proper error.
        std::mem::take(&mut self.response)
    }
}

// ---------- Stream wrapper ----------

/// Wrapper to unify TLS / plain streams so Session can be generic.
pub(crate) enum ImapStream {
    Tls(TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl tokio::io::AsyncRead for ImapStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for ImapStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

impl std::fmt::Debug for ImapStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImapStream::Tls(_) => write!(f, "ImapStream::Tls"),
            ImapStream::Plain(_) => write!(f, "ImapStream::Plain"),
        }
    }
}

// ---------- TLS helper ----------

/// Build a TLS connector, optionally accepting invalid certificates
/// (for local mail bridges like ProtonMail Bridge with self-signed certs).
fn build_tls_connector(accept_invalid_certs: bool) -> Result<native_tls::TlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("Failed to create TLS connector: {e}"))
}

// ---------- Public API ----------

type ImapSession = Session<ImapStream>;

/// Establish an IMAP connection and authenticate.
///
/// Supports TLS (direct), STARTTLS (upgrade), and plain connections.
/// Auth methods: "password" (LOGIN) or "oauth2" (XOAUTH2).
///
/// Wraps the entire connection + auth sequence in a 60s overall timeout.
pub async fn connect(config: &ImapConfig) -> Result<ImapSession, String> {
    tokio::time::timeout(OVERALL_CONNECT_TIMEOUT, connect_inner(config))
        .await
        .map_err(|_| format!(
            "IMAP connection to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, OVERALL_CONNECT_TIMEOUT.as_secs()
        ))?
}

async fn connect_inner(config: &ImapConfig) -> Result<ImapSession, String> {
    if config.security == "starttls" {
        return connect_starttls(config).await;
    }

    let stream = connect_stream(config).await?;
    let client = Client::new(stream);

    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

/// List all IMAP folders/mailboxes.
pub async fn list_folders(session: &mut ImapSession) -> Result<Vec<ImapFolder>, String> {
    let names_stream = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.list(Some(""), Some("*")))
        .await
        .map_err(|_| {
            format!(
                "LIST timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("LIST failed: {e}"))?;

    let names: Vec<_> = tokio::time::timeout(IMAP_CMD_TIMEOUT, names_stream.collect::<Vec<_>>())
        .await
        .map_err(|_| format!("LIST stream timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut folders = Vec::new();
    for name in &names {
        let raw_path = name.name().to_string();
        let delimiter = name.delimiter().unwrap_or("/").to_string();

        // Decode modified UTF-7 (RFC 3501 §5.1.3) to UTF-8 for display
        let path = utf7_imap::decode_utf7_imap(raw_path.clone());

        // Extract display name (last segment after delimiter)
        let display_name = path
            .rsplit_once(&delimiter)
            .map(|(_, last)| last.to_string())
            .unwrap_or_else(|| path.clone());

        // Detect special-use from attributes (RFC 6154)
        let special_use = detect_special_use(name);

        // Get message counts via STATUS — use raw_path for IMAP commands
        let (exists, unseen) = match tokio::time::timeout(
            IMAP_CMD_TIMEOUT,
            session.status(&raw_path, "(MESSAGES UNSEEN)"),
        )
        .await
        {
            Ok(Ok(mailbox)) => (mailbox.exists, mailbox.unseen.unwrap_or(0)),
            _ => (0, 0),
        };

        folders.push(ImapFolder {
            path,
            raw_path,
            name: display_name,
            delimiter,
            special_use,
            exists,
            unseen,
        });
    }

    Ok(folders)
}

/// Fetch messages from a folder by UID range (e.g. "1:100" or "500:*").
pub async fn fetch_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    log::info!(
        "IMAP SELECT {folder}: exists={}, uidvalidity={}, uidnext={}, fetching UIDs: {uid_range}",
        mailbox.exists,
        mailbox.uid_validity.unwrap_or(0),
        mailbox.uid_next.unwrap_or(0),
    );

    // Try UID FETCH first; if the stream is empty, fall back to sequence-number FETCH.
    // Some IMAP servers return empty streams for UID FETCH despite valid UIDs.
    let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(uid_range, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
            .await
            .map_err(|e| format!("UID FETCH {folder} uids={uid_range} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

    let raw_fetches: Vec<_> = fetches?;
    let mut fetch_ok = 0u32;
    let mut fetch_err = 0u32;
    let mut fetches = Vec::new();
    for r in raw_fetches {
        match r {
            Ok(f) => {
                fetch_ok += 1;
                fetches.push(f);
            }
            Err(e) => {
                fetch_err += 1;
                log::warn!("IMAP fetch stream error in {folder}: {e}");
            }
        }
    }
    log::info!("IMAP FETCH {folder}: {fetch_ok} ok, {fetch_err} errors from uid_fetch");

    // If async-imap returned nothing but messages exist, fallback to raw TCP fetch
    if fetches.is_empty() && mailbox.exists > 0 {
        log::warn!("IMAP {folder}: async-imap returned 0 items but exists={}. Falling back to raw TCP fetch...", mailbox.exists);
        // Return early with raw fetch result — caller doesn't need to know about the fallback
        return Err(format!("ASYNC_IMAP_EMPTY:{folder}"));
    }

    let parser = MessageParser::default();
    let mut messages = Vec::new();
    for fetch in &fetches {
        let uid = match fetch.uid {
            Some(u) => u,
            None => {
                log::warn!("IMAP FETCH {folder}: response missing UID");
                continue;
            }
        };

        let raw = match fetch.body() {
            Some(b) => b,
            None => {
                log::warn!("IMAP FETCH {folder}: UID {uid} has no body");
                continue;
            }
        };

        let raw_size = raw.len() as u32;

        // Parse flags
        let flags: Vec<_> = fetch.flags().collect();
        let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
        let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
        let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));

        // Extract INTERNALDATE as fallback for messages with unparseable Date headers
        let internal_date = fetch.internal_date().map(|dt| dt.timestamp());

        match parse_message(
            &parser,
            raw,
            uid,
            folder,
            raw_size,
            is_read,
            is_starred,
            is_draft,
            internal_date,
        ) {
            Ok(msg) => messages.push(msg),
            Err(e) => {
                log::warn!("Failed to parse message UID {uid}: {e}");
            }
        }
    }

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// Fetch a single message body by UID.
pub async fn fetch_message_body(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<ImapMessage, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "(UID FLAGS BODY.PEEK[])")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH for UID {uid} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    let raw_size = raw.len() as u32;
    let flags: Vec<_> = fetch.flags().collect();
    let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
    let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
    let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));

    let parser = MessageParser::default();
    parse_message(
        &parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, None,
    )
}

/// Get UIDs of messages newer than `last_uid`.
pub async fn fetch_new_uids(
    session: &mut ImapSession,
    folder: &str,
    last_uid: u32,
) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{}:*", last_uid + 1);
    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query))
        .await
        .map_err(|_| {
            format!(
                "UID SEARCH timed out after {}s — check your server settings or network connection",
                IMAP_SEARCH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("UID SEARCH failed: {e}"))?;

    // Filter out last_uid itself (IMAP returns it if it's the highest UID)
    let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > last_uid).collect();
    result.sort();
    Ok(result)
}

/// Search for all UIDs in a folder using `UID SEARCH ALL`.
/// Returns real UIDs sorted ascending — avoids the sparse UID gap problem.
pub async fn search_all_uids(session: &mut ImapSession, folder: &str) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| format!("UID SEARCH ALL timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH ALL failed: {e}"))?;

    let mut result: Vec<u32> = uids.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Set or remove flags on messages.
///
/// `flag_op`: "+FLAGS" to add, "-FLAGS" to remove
/// `flags`: e.g. "(\\Seen)" or "(\\Flagged)"
pub async fn set_flags(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    flag_op: &str,
    flags: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{flag_op} {flags}");
    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let stream = session
            .uid_store(uid_set, &query)
            .await
            .map_err(|e| format!("UID STORE failed: {e}"))?;
        let _: Vec<_> = stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| {
        format!(
            "UID STORE timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })?
}

/// Move messages between folders.
///
/// Tries MOVE first; falls back to COPY + flag Deleted + EXPUNGE.
pub async fn move_messages(
    session: &mut ImapSession,
    source_folder: &str,
    uid_set: &str,
    dest_folder: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(source_folder))
        .await
        .map_err(|_| format!("SELECT {source_folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {source_folder} failed: {e}"))?;

    // Try MOVE extension first
    match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_mv(uid_set, dest_folder)).await {
        Ok(Ok(())) => return Ok(()),
        _ => {
            // Fallback: COPY, then mark Deleted, then EXPUNGE
            tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_copy(uid_set, dest_folder))
                .await
                .map_err(|_| format!("UID COPY timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
                .map_err(|e| format!("UID COPY failed: {e}"))?;

            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let store_stream = session
                    .uid_store(uid_set, "+FLAGS (\\Deleted)")
                    .await
                    .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
                let _: Vec<_> = store_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

            expunge_uid_set(session, uid_set).await?;
        }
    }

    Ok(())
}

/// Format a value as an IMAP quoted string (RFC 3501 section 4.3).
///
/// The quoted-specials are the double quote and the backslash, and both have
/// to be escaped with a backslash. Interpolated raw, a password containing a
/// quote closes the string early and the remainder is parsed as further
/// arguments, so the command fails — or, worse, is understood as something
/// other than what was meant.
///
/// CR and LF cannot appear in a quoted string at all: they end the command
/// line, and everything after them would be read as a new command. There is
/// no escape for them, only a literal, so a value containing one is refused
/// here rather than sent.
///
/// Escaping happens in one pass. Replacing the quotes and then the
/// backslashes, or the other way round, would escape the backslashes the
/// first pass had just inserted.
fn imap_quote(value: &str) -> Result<String, String> {
    if value.contains('\r') || value.contains('\n') {
        return Err("IMAP arguments cannot contain a line break".to_string());
    }

    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    Ok(quoted)
}

/// What may be expunged after messages have been flagged \Deleted.
///
/// A bare `EXPUNGE` (RFC 3501 section 6.4.3) removes *every* \Deleted message
/// in the mailbox, not only the ones this client just marked. Another client
/// may have flagged messages and deliberately not expunged them — that is the
/// normal way IMAP clients implement a trash that can still be emptied later —
/// and expunging them here destroys mail this app was never asked to touch.
#[derive(Debug, PartialEq, Eq)]
enum ExpungeMode {
    /// `UID EXPUNGE` (RFC 4315 section 2.1) removes only the UIDs named, and
    /// only those among them that carry \Deleted.
    ByUid,
    /// The server does not advertise UIDPLUS, so there is no way to limit the
    /// command to this client's own messages. The flag is left set instead:
    /// the message is marked for deletion and a client that can expunge it
    /// safely, or the server's own housekeeping, will remove it. Losing
    /// somebody else's mail is the worse outcome.
    Nothing,
}

/// Decide how to expunge, given whether the server advertises UIDPLUS.
fn expunge_mode(has_uidplus: bool) -> ExpungeMode {
    if has_uidplus {
        ExpungeMode::ByUid
    } else {
        ExpungeMode::Nothing
    }
}

/// Remove the messages in `uid_set` that are flagged \Deleted, if that can be
/// done without touching anything else in the mailbox.
async fn expunge_uid_set(session: &mut ImapSession, uid_set: &str) -> Result<(), String> {
    let capabilities = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.capabilities())
        .await
        .map_err(|_| {
            format!(
                "CAPABILITY timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("CAPABILITY failed: {e}"))?;

    match expunge_mode(capabilities.has_str("UIDPLUS")) {
        ExpungeMode::Nothing => {
            log::warn!(
                "Server does not advertise UIDPLUS; leaving {uid_set} flagged \\Deleted rather \
                 than expunging the whole mailbox"
            );
            Ok(())
        }
        ExpungeMode::ByUid => {
            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let expunge_stream = session
                    .uid_expunge(uid_set)
                    .await
                    .map_err(|e| format!("UID EXPUNGE failed: {e}"))?;
                let _: Vec<_> = expunge_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| {
                format!(
                    "UID EXPUNGE timed out after {}s — check your server settings or network connection",
                    IMAP_CMD_TIMEOUT.as_secs()
                )
            })??;
            Ok(())
        }
    }
}

/// Flag messages as deleted and expunge them.
pub async fn delete_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let store_stream = session
            .uid_store(uid_set, "+FLAGS (\\Deleted)")
            .await
            .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
        let _: Vec<_> = store_stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

    expunge_uid_set(session, uid_set).await?;

    Ok(())
}

/// Append a raw message to a folder (for saving sent mail or drafts).
pub async fn append_message(
    session: &mut ImapSession,
    folder: &str,
    flags: Option<&str>,
    raw_message: &[u8],
) -> Result<(), String> {
    tokio::time::timeout(
        IMAP_FETCH_TIMEOUT,
        session.append(folder, flags, None, raw_message),
    )
    .await
    .map_err(|_| {
        format!(
            "APPEND timed out after {}s — check your server settings or network connection",
            IMAP_FETCH_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("APPEND failed: {e}"))
}

/// Get folder status (UIDVALIDITY, UIDNEXT, MESSAGES, UNSEEN).
pub async fn get_folder_status(
    session: &mut ImapSession,
    folder: &str,
) -> Result<ImapFolderStatus, String> {
    let mailbox = tokio::time::timeout(
        IMAP_CMD_TIMEOUT,
        session.status(folder, "(UIDVALIDITY UIDNEXT MESSAGES UNSEEN)"),
    )
    .await
    .map_err(|_| {
        format!(
            "STATUS timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("STATUS failed: {e}"))?;

    Ok(ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    })
}

/// Fetch a specific MIME part (attachment) by UID and part ID.
/// Returns the decoded binary data as standard base64.
///
/// Fetches the full message via `BODY.PEEK[]`, parses it with `mail-parser`
/// (which handles all content-transfer-encoding decoding), and extracts
/// the requested part's decoded bytes.
pub async fn fetch_attachment(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH attachment failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH attachment timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("No response for UID {uid}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    // Parse the full message — mail-parser decodes content-transfer-encoding
    let parser = MessageParser::default();
    let message = parser
        .parse(raw)
        .ok_or_else(|| format!("Failed to parse message UID {uid}"))?;

    // Build section map and find the part index for the requested section path
    let section_map = build_imap_section_map(&message);
    let target_part_idx = section_map
        .iter()
        .find(|(_, section)| section.as_str() == part_id)
        .map(|(&idx, _)| idx)
        .ok_or_else(|| format!("Section {part_id} not found in message UID {uid}"))?;

    let part = message
        .parts
        .get(target_part_idx)
        .ok_or_else(|| format!("Part index {target_part_idx} out of range for UID {uid}"))?;

    // Extract the decoded binary content from the part
    let data = match &part.body {
        mail_parser::PartType::Binary(data) | mail_parser::PartType::InlineBinary(data) => {
            data.as_ref().to_vec()
        }
        mail_parser::PartType::Text(text) => text.as_bytes().to_vec(),
        mail_parser::PartType::Html(html) => html.as_bytes().to_vec(),
        mail_parser::PartType::Message(msg) => {
            // Nested message — encode the raw bytes
            msg.raw_message.as_ref().to_vec()
        }
        mail_parser::PartType::Multipart(_) => {
            return Err(format!(
                "Part {part_id} is a multipart container, not a leaf part"
            ));
        }
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

/// Fetch the raw RFC822 source of a single message by UID.
/// Returns the full message as a UTF-8 string (lossy conversion for non-UTF-8 bytes).
pub async fn fetch_raw_message(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH raw message timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    Ok(String::from_utf8_lossy(raw).to_string())
}

/// Check multiple folders for new UIDs in a single IMAP session.
///
/// For each folder: SELECT, compare UIDVALIDITY, UID SEARCH for new messages.
/// This replaces N separate connections (status + fetch_new_uids per folder)
/// with a single connection that checks all folders.
pub async fn delta_check_folders(
    session: &mut ImapSession,
    folders: &[DeltaCheckRequest],
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut results = Vec::with_capacity(folders.len());

    for req in folders {
        let mailbox =
            match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(&req.folder)).await {
                Ok(Ok(m)) => m,
                Ok(Err(e)) => {
                    log::warn!("delta_check: SELECT {} failed: {e}", req.folder);
                    continue;
                }
                Err(_) => {
                    log::warn!(
                        "delta_check: SELECT {} timed out after {}s",
                        req.folder,
                        IMAP_CMD_TIMEOUT.as_secs()
                    );
                    continue;
                }
            };

        let current_uidvalidity = mailbox.uid_validity.unwrap_or(0);
        let uidvalidity_changed = req.uidvalidity != 0 && current_uidvalidity != req.uidvalidity;

        if uidvalidity_changed {
            results.push(DeltaCheckResult {
                folder: req.folder.clone(),
                uidvalidity: current_uidvalidity,
                new_uids: vec![],
                uidvalidity_changed: true,
            });
            continue;
        }

        // UID SEARCH for messages newer than last_uid
        let query = format!("{}:*", req.last_uid + 1);
        let new_uids = match tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query))
            .await
        {
            Ok(Ok(uids)) => {
                let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > req.last_uid).collect();
                result.sort();
                result
            }
            Ok(Err(e)) => {
                log::warn!("delta_check: UID SEARCH {} failed: {e}", req.folder);
                vec![]
            }
            Err(_) => {
                log::warn!(
                    "delta_check: UID SEARCH {} timed out after {}s",
                    req.folder,
                    IMAP_SEARCH_TIMEOUT.as_secs()
                );
                vec![]
            }
        };

        results.push(DeltaCheckResult {
            folder: req.folder.clone(),
            uidvalidity: current_uidvalidity,
            new_uids,
            uidvalidity_changed: false,
        });
    }

    Ok(results)
}

/// Search a folder: SELECT → UID SEARCH, returning UIDs and folder status without fetching bodies.
///
/// This is a lightweight alternative to `sync_folder` for callers that want to
/// fetch messages in smaller IPC-friendly chunks on the TypeScript side.
pub async fn search_folder(
    session: &mut ImapSession,
    folder: &str,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    // SELECT the folder
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    // UID SEARCH with optional SINCE date filter (RFC 3501 §6.4.4)
    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP search_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}",
        uids.len(),
        folder_status.uidvalidity,
    );

    Ok(ImapFolderSearchResult {
        uids,
        folder_status,
    })
}

/// Sync a folder in a single IMAP session: SELECT → UID SEARCH → batched UID FETCH.
///
/// When `since_date` is provided (format `DD-Mon-YYYY`), uses `UID SEARCH SINCE <date>`
/// to only fetch messages from that date onward, avoiding timeouts on large folders.
///
/// This avoids creating multiple TCP connections per folder (one for search,
/// one per batch for fetch) which causes connection storms on servers with
/// many folders.
pub async fn sync_folder(
    session: &mut ImapSession,
    folder: &str,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    // SELECT the folder
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    // UID SEARCH with optional SINCE date filter (RFC 3501 §6.4.4)
    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP sync_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}, batch_size={}",
        uids.len(),
        folder_status.uidvalidity,
        batch_size,
    );

    if uids.is_empty() {
        return Ok(ImapFolderSyncResult {
            uids,
            messages: vec![],
            folder_status,
        });
    }

    // Fetch in batches on the SAME session
    let parser = MessageParser::default();
    let mut all_messages = Vec::new();
    let bs = batch_size as usize;

    for chunk in uids.chunks(bs) {
        let uid_set: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
            let stream = session
                .uid_fetch(&uid_set, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

        let raw_fetches: Vec<_> = fetches?;
        for r in raw_fetches {
            match r {
                Ok(f) => {
                    let uid = match f.uid {
                        Some(u) => u,
                        None => {
                            log::warn!("IMAP sync_folder {folder}: response missing UID");
                            continue;
                        }
                    };
                    let raw = match f.body() {
                        Some(b) => b,
                        None => {
                            log::warn!("IMAP sync_folder {folder}: UID {uid} has no body");
                            continue;
                        }
                    };
                    let raw_size = raw.len() as u32;
                    let flags: Vec<_> = f.flags().collect();
                    let is_read = flags.iter().any(|fl| matches!(fl, Flag::Seen));
                    let is_starred = flags.iter().any(|fl| matches!(fl, Flag::Flagged));
                    let is_draft = flags.iter().any(|fl| matches!(fl, Flag::Draft));
                    let internal_date = f.internal_date().map(|dt| dt.timestamp());

                    match parse_message(
                        &parser,
                        raw,
                        uid,
                        folder,
                        raw_size,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                    ) {
                        Ok(msg) => all_messages.push(msg),
                        Err(e) => log::warn!("sync_folder: failed to parse UID {uid}: {e}"),
                    }
                }
                Err(e) => log::warn!("IMAP sync_folder fetch stream error in {folder}: {e}"),
            }
        }
    }

    log::info!(
        "IMAP sync_folder {folder}: fetched {} messages",
        all_messages.len()
    );

    Ok(ImapFolderSyncResult {
        uids,
        messages: all_messages,
        folder_status,
    })
}

/// Test IMAP connectivity: connect, login, list, logout.
pub async fn test_connection(config: &ImapConfig) -> Result<String, String> {
    let mut session = connect(config).await?;

    // Try listing folders to verify access
    let count = tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let names = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| format!("LIST failed: {e}"))?;
        Ok::<_, String>(names.collect::<Vec<_>>().await.len())
    })
    .await
    .map_err(|_| {
        format!(
            "LIST timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })??;

    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.logout()).await;

    Ok(format!(
        "Connected successfully. Found {} folder(s).",
        count
    ))
}

/// Raw IMAP fetch: connect via raw TCP/TLS (bypassing async-imap),
/// authenticate, SELECT folder, UID FETCH with full body, parse responses.
///
/// This is a fallback for servers where async-imap fails to parse responses
/// (e.g. Mailo with non-standard flags like `Sent` without backslash).
pub async fn raw_fetch_messages(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    log::info!(
        "RAW IMAP FETCH: connecting to {}:{} for folder {folder}, UIDs {uid_range}",
        config.host,
        config.port
    );

    // Connect
    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut reader = BufReader::new(stream);

    // Read greeting (for non-STARTTLS)
    if config.security != "starttls" {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
    }

    // LOGIN
    let login_cmd = if config.auth_method == "oauth2" {
        // XOAUTH2: AUTHENTICATE XOAUTH2 <base64>
        let xoauth2 = format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            config.username, config.password
        );
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            xoauth2.as_bytes(),
        );
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!(
            "a1 LOGIN {} {}\r\n",
            imap_quote(&config.username)?,
            imap_quote(&config.password)?
        )
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    // SELECT
    let select_cmd = format!("a2 SELECT {}\r\n", imap_quote(folder)?);
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    // Parse SELECT response for UIDVALIDITY, EXISTS, UNSEEN
    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    // UID FETCH with full body
    let fetch_cmd = format!("a3 UID FETCH {uid_range} (UID FLAGS INTERNALDATE BODY.PEEK[])\r\n");
    reader
        .get_mut()
        .write_all(fetch_cmd.as_bytes())
        .await
        .map_err(|e| format!("FETCH write: {e}"))?;

    // Parse FETCH responses with literal handling
    let raw_messages = raw_parse_fetch_responses(&mut reader, "a3").await?;

    log::info!(
        "RAW IMAP FETCH {folder}: parsed {} raw messages",
        raw_messages.len()
    );

    // Parse each raw message
    let parser = MessageParser::default();
    let mut messages = Vec::new();

    for raw_msg in &raw_messages {
        match parse_message(
            &parser,
            &raw_msg.body,
            raw_msg.uid,
            folder,
            raw_msg.body.len() as u32,
            raw_msg.is_read,
            raw_msg.is_starred,
            raw_msg.is_draft,
            raw_msg.internal_date,
        ) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("RAW FETCH: failed to parse UID {}: {e}", raw_msg.uid),
        }
    }

    // LOGOUT
    let _ = reader.get_mut().write_all(b"a4 LOGOUT\r\n").await;

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// Raw IMAP diagnostic: connect via raw TCP/TLS (bypassing async-imap),
/// authenticate, SELECT folder, FETCH, and return raw server response.
/// This helps diagnose servers that async-imap can't parse.
pub async fn raw_fetch_diagnostic(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<String, String> {
    // Connect and wrap in our ImapStream
    let mut stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut buf = vec![0u8; 16384];
    let mut output = String::new();

    // Read greeting (for non-STARTTLS)
    if config.security != "starttls" {
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
        output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));
    }

    // LOGIN
    let login_cmd = format!(
        "a1 LOGIN {} {}\r\n",
        imap_quote(&config.username)?,
        imap_quote(&config.password)?
    );
    stream
        .write_all(login_cmd.as_bytes())
        .await
        .map_err(|e| format!("LOGIN: {e}"))?;
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("LOGIN read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    // SELECT
    let select_cmd = format!("a2 SELECT {}\r\n", imap_quote(folder)?);
    stream
        .write_all(select_cmd.as_bytes())
        .await
        .map_err(|e| format!("SELECT: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("SELECT read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    // UID FETCH — just get UID and FLAGS first (small response)
    let fetch_cmd = format!("a3 UID FETCH {uid_range} (UID FLAGS)\r\n");
    stream
        .write_all(fetch_cmd.as_bytes())
        .await
        .map_err(|e| format!("FETCH: {e}"))?;

    let mut fetch_response = String::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        match tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                fetch_response.push_str(&String::from_utf8_lossy(&buf[..n]));
                if fetch_response.contains("a3 OK")
                    || fetch_response.contains("a3 NO")
                    || fetch_response.contains("a3 BAD")
                {
                    break;
                }
            }
            Ok(Err(e)) => {
                fetch_response.push_str(&format!("[read error: {e}]"));
                break;
            }
            Err(_) => {
                fetch_response.push_str("[timeout]");
                break;
            }
        }
    }
    output.push_str(&format!("FETCH response:\n{fetch_response}"));

    let _ = stream.write_all(b"a4 LOGOUT\r\n").await;

    log::info!("RAW IMAP DIAGNOSTIC for {folder}:\n{output}");

    Ok(output)
}

// ---------- Raw TCP helpers ----------

/// Intermediate struct for a raw-parsed IMAP message before mail-parser processing.
struct RawFetchedMessage {
    uid: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
    body: Vec<u8>,
}

/// Connect via STARTTLS for raw TCP operations.
async fn raw_connect_starttls(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP: {e}"))?;
    configure_tcp_socket(&tcp);
    let mut tmp = vec![0u8; 4096];
    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp)).await; // consume greeting
    tcp.write_all(b"a0 STARTTLS\r\n")
        .await
        .map_err(|e| format!("STARTTLS: {e}"))?;
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("STARTTLS resp: {e}"))?;
    let resp = String::from_utf8_lossy(&tmp[..n]);
    if !resp.contains("OK") {
        return Err(format!("STARTTLS rejected: {resp}"));
    }
    let nc = build_tls_connector(config.accept_invalid_certs)?;
    let tc = tokio_native_tls::TlsConnector::from(nc);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tc.connect(&config.host, tcp))
        .await
        .map_err(|_| {
            format!(
            "TLS handshake timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        )
        })?
        .map_err(|e| format!("TLS: {e}"))?;
    Ok(ImapStream::Tls(tls))
}

/// Send a command and read all response lines until the tagged response (e.g. "a1 OK ...").
async fn raw_send_and_wait(
    reader: &mut tokio::io::BufReader<ImapStream>,
    cmd: &[u8],
    tag: &str,
) -> Result<String, String> {
    reader
        .get_mut()
        .write_all(cmd)
        .await
        .map_err(|e| format!("{tag} write: {e}"))?;

    let mut response = String::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            reader.read_line(&mut line),
        )
        .await
        {
            Ok(Ok(0)) => return Err(format!("{tag}: connection closed")),
            Ok(Ok(_)) => {
                response.push_str(&line);
                if line.starts_with(&tag_ok) {
                    return Ok(response);
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("{tag} failed: {line}"));
                }
            }
            Ok(Err(e)) => return Err(format!("{tag} read: {e}")),
            Err(_) => return Err(format!("{tag}: timeout")),
        }
    }
}

/// Parse untagged responses like "* 3 EXISTS" → 3
fn parse_untagged_number(line: &str, keyword: &str) -> Option<u32> {
    // Format: "* <number> <KEYWORD>"
    let trimmed = line.trim();
    if !trimmed.starts_with("* ") || !trimmed.ends_with(keyword) {
        return None;
    }
    let middle = trimmed[2..trimmed.len() - keyword.len()].trim();
    middle.parse().ok()
}

/// Extract a number from bracket notation like "[UIDVALIDITY 12345]"
fn extract_bracket_number(line: &str, keyword: &str) -> Option<u32> {
    let pattern = format!("[{keyword} ");
    if let Some(start) = line.find(&pattern) {
        let after = &line[start + pattern.len()..];
        if let Some(end) = after.find(']') {
            return after[..end].trim().parse().ok();
        }
    }
    None
}

/// Parse IMAP FETCH responses with literal support ({size}\r\n...data...).
///
/// IMAP FETCH response format:
/// ```text
/// * 1 FETCH (UID 1 FLAGS (\Seen) INTERNALDATE "16-Feb-2026 12:00:00 +0000" BODY[] {1234}
/// <1234 bytes of raw email data>
/// )
/// a3 OK UID FETCH done
/// ```
async fn raw_parse_fetch_responses(
    reader: &mut tokio::io::BufReader<ImapStream>,
    tag: &str,
) -> Result<Vec<RawFetchedMessage>, String> {
    let mut messages: Vec<RawFetchedMessage> = Vec::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            reader.read_line(&mut line),
        )
        .await
        {
            Ok(Ok(0)) => return Err("Connection closed during FETCH".to_string()),
            Ok(Ok(_)) => {
                // Check for tagged response (end of FETCH)
                if line.starts_with(&tag_ok) {
                    break;
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("FETCH failed: {line}"));
                }

                // Check for untagged FETCH response: "* <seq> FETCH (...)"
                if !line.starts_with("* ") || !line.contains("FETCH") {
                    continue;
                }

                // Parse UID from the response line
                let uid = extract_fetch_uid(&line).unwrap_or(0);
                if uid == 0 {
                    log::warn!("RAW FETCH: could not parse UID from: {}", line.trim());
                    // Still need to consume any literal
                    if let Some(literal_size) = extract_literal_size(&line) {
                        let mut discard = vec![0u8; literal_size];
                        reader
                            .read_exact(&mut discard)
                            .await
                            .map_err(|e| format!("discard literal: {e}"))?;
                    }
                    continue;
                }

                // Parse flags
                let flags_str = extract_flags_from_fetch(&line);
                let is_read = flags_str.contains("\\Seen");
                let is_starred = flags_str.contains("\\Flagged");
                let is_draft = flags_str.contains("\\Draft");

                // Parse INTERNALDATE
                let internal_date = extract_internal_date(&line);

                // Check for literal: {size}
                if let Some(literal_size) = extract_literal_size(&line) {
                    // Read exactly `literal_size` bytes
                    let mut body = vec![0u8; literal_size];
                    reader
                        .read_exact(&mut body)
                        .await
                        .map_err(|e| format!("read literal for UID {uid}: {e}"))?;

                    // Read the closing ")\r\n" after the literal
                    let mut closing = String::new();
                    let _ = reader.read_line(&mut closing).await;

                    messages.push(RawFetchedMessage {
                        uid,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                        body,
                    });
                }
            }
            Ok(Err(e)) => return Err(format!("FETCH read: {e}")),
            Err(_) => return Err("FETCH timeout".to_string()),
        }
    }

    Ok(messages)
}

/// Extract UID from a FETCH response line like "* 1 FETCH (UID 123 FLAGS ...)"
fn extract_fetch_uid(line: &str) -> Option<u32> {
    // Look for "UID " followed by a number
    let uid_idx = line.find("UID ")?;
    let after_uid = &line[uid_idx + 4..];
    let end = after_uid
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after_uid.len());
    after_uid[..end].parse().ok()
}

/// Extract flags string from FETCH response like "FLAGS (\Seen \Flagged)"
fn extract_flags_from_fetch(line: &str) -> String {
    if let Some(flags_start) = line.find("FLAGS (") {
        let after = &line[flags_start + 7..];
        if let Some(end) = after.find(')') {
            return after[..end].to_string();
        }
    }
    String::new()
}

/// Extract INTERNALDATE from FETCH response.
/// Format: INTERNALDATE "16-Feb-2026 12:00:00 +0000"
/// Returns None if not present — mail-parser will use the Date header instead.
fn extract_internal_date(line: &str) -> Option<i64> {
    let idx = line.find("INTERNALDATE \"")?;
    let after = &line[idx + 14..];
    let end = after.find('"')?;
    let date_str = &after[..end];
    // Parse "DD-Mon-YYYY HH:MM:SS +ZZZZ" manually
    parse_imap_date(date_str)
}

/// Parse IMAP date format "16-Feb-2026 12:00:00 +0000" to Unix timestamp.
fn parse_imap_date(s: &str) -> Option<i64> {
    // INTERNALDATE is an RFC 5322 date with "-" between day, month and year.
    // Swap those for spaces (only in the date part, the zone keeps its sign).
    let (date, rest) = s.trim().split_once(' ')?;
    // mail-parser hashes the month name and accepts any three letters, so check it.
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = date.split('-').nth(1)?;
    if !MONTHS.iter().any(|m| m.eq_ignore_ascii_case(month)) {
        return None;
    }
    let dt = mail_parser::DateTime::parse_rfc822(&format!("{} {rest}", date.replace('-', " ")))?;
    dt.is_valid().then(|| dt.to_timestamp())
}

/// Extract literal size from a line ending with {1234}\r\n
fn extract_literal_size(line: &str) -> Option<usize> {
    let trimmed = line.trim_end();
    if !trimmed.ends_with('}') {
        return None;
    }
    let brace_start = trimmed.rfind('{')?;
    trimmed[brace_start + 1..trimmed.len() - 1].parse().ok()
}

// ---------- Internal helpers ----------

/// Establish TCP + TLS or plain stream for "tls" and "none" security modes.
async fn connect_stream(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);

    match config.security.as_str() {
        "tls" => {
            let native_connector = build_tls_connector(config.accept_invalid_certs)?;
            let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
                .await
                .map_err(|_| format!(
                    "TLS handshake with {} timed out after {}s — check your server settings or network connection",
                    config.host, TLS_HANDSHAKE_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TLS handshake with {} failed: {e}", config.host))?;
            Ok(ImapStream::Tls(tls))
        }
        "none" => {
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            Ok(ImapStream::Plain(tcp))
        }
        other => Err(format!(
            "Unknown security mode: {other}. Use \"tls\", \"starttls\", or \"none\"."
        )),
    }
}

/// Handle STARTTLS connection: connect plain, upgrade to TLS, then authenticate.
///
/// STARTTLS is special because we must issue the STARTTLS command on the plain
/// connection, upgrade the underlying TCP stream to TLS, and then create a new
/// Client on the TLS stream for authentication.
async fn connect_starttls(config: &ImapConfig) -> Result<ImapSession, String> {
    let addr = (&*config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
    configure_tcp_socket(&tcp);

    // Read the server greeting
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "Reading server greeting timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read server greeting: {e}"))?;
    let greeting = String::from_utf8_lossy(&buf[..n]);
    if !greeting.contains("OK") {
        return Err(format!("Unexpected server greeting: {greeting}"));
    }

    // Send STARTTLS command
    tcp.write_all(b"a001 STARTTLS\r\n")
        .await
        .map_err(|e| format!("Failed to send STARTTLS: {e}"))?;

    // Read STARTTLS response
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read STARTTLS response: {e}"))?;
    let response = String::from_utf8_lossy(&buf[..n]);
    if !response.contains("OK") {
        return Err(format!("STARTTLS rejected: {response}"));
    }

    // Upgrade to TLS
    let native_connector = build_tls_connector(config.accept_invalid_certs)?;
    let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
        .await
        .map_err(|_| format!(
            "TLS upgrade after STARTTLS timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TLS upgrade after STARTTLS failed: {e}"))?;

    // Create a new IMAP client on the TLS stream and authenticate
    let client = Client::new(ImapStream::Tls(tls));
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

/// Authenticate with the IMAP server (LOGIN or XOAUTH2).
async fn authenticate(
    client: Client<ImapStream>,
    config: &ImapConfig,
) -> Result<ImapSession, String> {
    match config.auth_method.as_str() {
        "oauth2" => {
            let auth = XOAuth2::new(&config.username, &config.password);
            client
                .authenticate("XOAUTH2", auth)
                .await
                .map_err(|(e, _)| format!("XOAUTH2 authentication failed: {e}"))
        }
        _ => client
            .login(&config.username, &config.password)
            .await
            .map_err(|(e, _)| format!("Login failed: {e}")),
    }
}

/// Detect special-use attribute from IMAP folder attributes and name heuristics.
fn detect_special_use(name: &async_imap::types::Name) -> Option<String> {
    use async_imap::types::NameAttribute;

    // Check RFC 6154 attributes first
    for attr in name.attributes() {
        let special = match attr {
            NameAttribute::Sent => Some("\\Sent"),
            NameAttribute::Trash => Some("\\Trash"),
            NameAttribute::Drafts => Some("\\Drafts"),
            NameAttribute::Junk => Some("\\Junk"),
            NameAttribute::Archive => Some("\\Archive"),
            NameAttribute::All => Some("\\All"),
            NameAttribute::Flagged => Some("\\Flagged"),
            _ => None,
        };
        if let Some(s) = special {
            return Some(s.to_string());
        }
    }

    // Heuristic fallback based on common folder names
    let lower = name.name().to_lowercase();
    match lower.as_str() {
        "inbox" => Some("\\Inbox".to_string()),
        "sent" | "sent messages" | "sent items" | "[gmail]/sent mail" => Some("\\Sent".to_string()),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" | "corbeille"
        | "unsolbox" | "[gmail]/trash" => Some("\\Trash".to_string()),
        "drafts" | "draft" | "draftbox" | "brouillons" | "[gmail]/drafts" => {
            Some("\\Drafts".to_string())
        }
        "junk" | "spam" | "junk e-mail" | "[gmail]/spam" => Some("\\Junk".to_string()),
        "archive" | "archives" | "[gmail]/all mail" => Some("\\Archive".to_string()),
        _ => None,
    }
}

/// Parse a raw email message into our ImapMessage struct.
///
/// `internal_date`: optional INTERNALDATE timestamp from the IMAP server,
/// used as fallback when the Date header cannot be parsed.
#[allow(clippy::too_many_arguments)]
fn parse_message(
    parser: &MessageParser,
    raw: &[u8],
    uid: u32,
    folder: &str,
    raw_size: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
) -> Result<ImapMessage, String> {
    let message = parser.parse(raw).ok_or("Failed to parse MIME message")?;

    let message_id = message.message_id().map(|s| s.to_string());
    let subject = message.subject().map(|s| s.to_string());
    let date = message
        .date()
        .map(|d| d.to_timestamp())
        .or(internal_date)
        .unwrap_or(0);

    // In-Reply-To
    let in_reply_to = match message.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => list.first().map(|s| s.to_string()),
        _ => None,
    };

    // References (space-separated message IDs)
    let references = match message.references() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => {
            if list.is_empty() {
                None
            } else {
                Some(
                    list.iter()
                        .map(|s| s.as_ref())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            }
        }
        _ => None,
    };

    // Addresses
    let (from_address, from_name) = extract_first_address(message.from());
    let to_addresses = format_address_list(message.to());
    let cc_addresses = format_address_list(message.cc());
    let bcc_addresses = format_address_list(message.bcc());
    let reply_to = format_address_list(message.reply_to());

    // Body
    let body_text = message.body_text(0).map(|s| s.to_string());
    let body_html = message.body_html(0).map(|s| s.to_string());

    // Generate snippet from text body (truncate at char boundary)
    let snippet = body_text.as_ref().map(|text| {
        let cleaned: String = text
            .chars()
            .map(|c| if c.is_whitespace() { ' ' } else { c })
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.chars().count() > 200 {
            let end: String = trimmed.chars().take(200).collect();
            format!("{end}...")
        } else {
            trimmed.to_string()
        }
    });

    // List-Unsubscribe headers
    let list_unsubscribe =
        extract_header_text(message.header(mail_parser::HeaderName::ListUnsubscribe));
    let list_unsubscribe_post = extract_header_text(message.header(
        mail_parser::HeaderName::Other("List-Unsubscribe-Post".into()),
    ));

    // Authentication-Results header
    let auth_results = extract_header_text(message.header(mail_parser::HeaderName::Other(
        "Authentication-Results".into(),
    )));

    // Build a map from mail-parser part index → IMAP MIME section path.
    // IMAP numbers children of multipart containers starting at 1 (e.g. "1", "2", "1.2.3").
    // mail-parser stores all parts flat in a Vec, with Multipart variants holding child indices.
    let section_map = build_imap_section_map(&message);

    log::debug!(
        "IMAP parse UID {uid}: {} parts, {} attachment indices {:?}, section_map: {:?}",
        message.parts.len(),
        message.attachments.len(),
        message.attachments,
        section_map,
    );

    // Attachments
    let attachments: Vec<ImapAttachment> = message
        .attachments
        .iter()
        .filter_map(|&part_idx| {
            let att = message.parts.get(part_idx)?;
            let section = match section_map.get(&part_idx) {
                Some(s) => s.clone(),
                None => {
                    log::warn!(
                        "IMAP UID {uid}: attachment at part index {part_idx} not found in section map (map has {} entries)",
                        section_map.len(),
                    );
                    return None;
                }
            };

            let mime_type = att
                .content_type()
                .map(|ct| {
                    let ctype = ct.ctype();
                    let subtype = ct.subtype().unwrap_or("octet-stream");
                    format!("{ctype}/{subtype}")
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());

            Some(ImapAttachment {
                part_id: section,
                filename: att
                    .attachment_name()
                    .unwrap_or("attachment")
                    .to_string(),
                mime_type,
                size: att.len() as u32,
                content_id: att.content_id().map(|s| s.to_string()),
                is_inline: att.content_disposition().is_some_and(|cd| cd.is_inline()),
            })
        })
        .collect();

    let content_hash = content_hash(
        body_text.as_deref(),
        body_html.as_deref(),
        message.attachments.iter().filter_map(|&i| {
            let part = message.parts.get(i)?;
            Some(AttachmentContent {
                filename: part.attachment_name().unwrap_or("attachment"),
                content_type: part.content_type().map_or("", |ct| ct.ctype()),
                content_subtype: part
                    .content_type()
                    .and_then(|ct| ct.subtype())
                    .unwrap_or(""),
                content_id: part.content_id().unwrap_or(""),
                is_inline: part.content_disposition().is_some_and(|cd| cd.is_inline()),
                bytes: part.contents(),
            })
        }),
    );

    Ok(ImapMessage {
        uid,
        folder: folder.to_string(),
        message_id,
        in_reply_to,
        references,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        reply_to,
        subject,
        date,
        is_read,
        is_starred,
        is_draft,
        body_html,
        body_text,
        snippet,
        raw_size,
        list_unsubscribe,
        list_unsubscribe_post,
        auth_results,
        attachments,
        content_hash,
    })
}

/// What `content_hash` reads of one attachment.
struct AttachmentContent<'a> {
    filename: &'a str,
    content_type: &'a str,
    content_subtype: &'a str,
    content_id: &'a str,
    is_inline: bool,
    bytes: &'a [u8],
}

/// SHA-256 (hex) of everything a reader sees of a message: the text part, the
/// HTML part and each attachment's metadata and decoded bytes. The threading
/// step compares it to tell folder copies from different mails that reuse a
/// Message-ID, so a part that is left out is a part a sender can swap.
///
/// Every field is length-prefixed ("ab"+"c" and "a"+"bc" differ, and so do an
/// absent part and an empty one). The attachment's MIME section is left out on
/// purpose: a copy of the same mail in another folder can be structured
/// differently and would otherwise never match.
fn content_hash<'a>(
    body_text: Option<&str>,
    body_html: Option<&str>,
    attachments: impl Iterator<Item = AttachmentContent<'a>>,
) -> String {
    fn field(hasher: &mut Sha256, bytes: &[u8]) {
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    fn optional(hasher: &mut Sha256, value: Option<&str>) {
        match value {
            Some(v) => {
                hasher.update([1u8]);
                field(hasher, v.as_bytes());
            }
            None => hasher.update([0u8]),
        }
    }

    let mut hasher = Sha256::new();
    optional(&mut hasher, body_text);
    optional(&mut hasher, body_html);
    for att in attachments {
        hasher.update([2u8]);
        field(&mut hasher, att.filename.as_bytes());
        field(&mut hasher, att.content_type.as_bytes());
        field(&mut hasher, att.content_subtype.as_bytes());
        field(&mut hasher, att.content_id.as_bytes());
        hasher.update([att.is_inline as u8]);
        field(&mut hasher, att.bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Build a mapping from mail-parser part index → IMAP MIME section path string.
///
/// IMAP section numbering: children of a multipart container are numbered 1, 2, 3, ...
/// Nested multipart children get dot-separated paths (e.g., "1.2" for the 2nd child of the 1st child).
/// For non-multipart messages, the single body is section "1".
fn build_imap_section_map(
    message: &mail_parser::Message,
) -> std::collections::HashMap<usize, String> {
    use mail_parser::PartType;

    let mut map = std::collections::HashMap::new();

    fn walk(
        parts: &[mail_parser::MessagePart],
        part_idx: usize,
        prefix: &str,
        map: &mut std::collections::HashMap<usize, String>,
    ) {
        if let Some(part) = parts.get(part_idx) {
            if let PartType::Multipart(children) = &part.body {
                for (i, &child_idx) in children.iter().enumerate() {
                    let section = if prefix.is_empty() {
                        format!("{}", i + 1)
                    } else {
                        format!("{}.{}", prefix, i + 1)
                    };
                    walk(parts, child_idx, &section, map);
                }
            } else {
                // Leaf part — use the section path as-is
                let section = if prefix.is_empty() {
                    // Non-multipart message: the body is section "1"
                    "1".to_string()
                } else {
                    prefix.to_string()
                };
                map.insert(part_idx, section);
            }
        }
    }

    // Start from part 0 (root) with empty prefix
    if !message.parts.is_empty() {
        walk(&message.parts, 0, "", &mut map);
    }

    map
}

/// Extract a text value from a HeaderValue, if present.
fn extract_header_text(hv: Option<&mail_parser::HeaderValue>) -> Option<String> {
    match hv {
        Some(mail_parser::HeaderValue::Text(t)) => Some(t.to_string()),
        Some(mail_parser::HeaderValue::TextList(list)) => Some(
            list.iter()
                .map(|s| s.as_ref())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        _ => None,
    }
}

/// Extract the first address (email, display name) from an Address field.
fn extract_first_address(addr: Option<&mail_parser::Address>) -> (Option<String>, Option<String>) {
    let addr = match addr {
        Some(a) => a,
        None => return (None, None),
    };

    if let Some(first) = addr.first() {
        let email = first.address.as_ref().map(|s| s.to_string());
        let name = first.name.as_ref().map(|s| s.to_string());
        (email, name)
    } else {
        (None, None)
    }
}

/// Format an address list as a comma-separated string of "Name <email>" or "email".
fn format_address_list(addr: Option<&mail_parser::Address>) -> Option<String> {
    let addr = addr?;

    let parts: Vec<String> = addr
        .iter()
        .map(|a| {
            let email = a.address.as_deref().unwrap_or("");
            match a.name.as_deref() {
                Some(name) if !name.is_empty() => format!("{name} <{email}>"),
                _ => email.to_string(),
            }
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A bare EXPUNGE removes every \Deleted message in the mailbox (RFC 3501
    // section 6.4.3), not only the ones this client marked. Clients routinely
    // flag messages and leave them unexpunged, so issuing it to delete two
    // messages of our own can destroy mail belonging to another client's
    // trash. UID EXPUNGE (RFC 4315 section 2.1) is limited to the UIDs named,
    // and where it is not offered the safe answer is to expunge nothing.

    #[test]
    fn uses_uid_expunge_when_the_server_offers_uidplus() {
        assert_eq!(expunge_mode(true), ExpungeMode::ByUid);
    }

    #[test]
    fn expunges_nothing_without_uidplus() {
        assert_eq!(expunge_mode(false), ExpungeMode::Nothing);
    }

    // RFC 3501 section 4.3: a quoted string is delimited by double quotes,
    // and the quoted-specials — the double quote and the backslash — are
    // escaped with a backslash. Neither CR nor LF is a valid character in one.

    #[test]
    fn quotes_an_ordinary_value() {
        assert_eq!(
            imap_quote("simon@hochreiner.xyz").unwrap(),
            "\"simon@hochreiner.xyz\""
        );
    }

    #[test]
    fn escapes_a_double_quote_in_a_password() {
        // Unescaped this closes the string, and the rest of the password is
        // read as further arguments to LOGIN.
        assert_eq!(imap_quote("pa\"ss").unwrap(), "\"pa\\\"ss\"");
    }

    #[test]
    fn escapes_a_backslash_in_a_password() {
        assert_eq!(imap_quote("pa\\ss").unwrap(), "\"pa\\\\ss\"");
    }

    #[test]
    fn escapes_a_backslash_and_a_quote_together() {
        // Escaping the two in separate passes would escape the backslashes
        // the other pass had just inserted.
        assert_eq!(imap_quote("a\\\"b").unwrap(), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn refuses_a_value_containing_a_line_break() {
        // A quoted string cannot hold one, and interpolating it would end the
        // command line and turn the remainder into a command of its own.
        assert!(imap_quote("pass\r\na2 DELETE INBOX").is_err());
        assert!(imap_quote("pass\nmore").is_err());
    }

    /// Both delete_messages and the COPY fallback in move_messages used to
    /// call the unqualified command directly. Nothing in the type system
    /// stops that from coming back, so the source is checked for it. The
    /// needle is assembled rather than written out, so this test does not
    /// match itself.
    #[test]
    fn no_call_site_issues_an_unqualified_expunge() {
        let source = include_str!("client.rs");
        let bare_call = concat!(".", "expunge()");
        assert!(
            !source.contains(bare_call),
            "a bare EXPUNGE removes every \\Deleted message in the mailbox, \
             including ones another client marked; use expunge_uid_set instead"
        );
    }

    // Messages that reuse one Message-ID are told apart by `content_hash`, so
    // it has to cover everything a reader sees of a message: a part that is
    // left out is a part a sender can swap while keeping the ID.

    fn mime(text: &str, html: &str, attachments: &[(&str, &str, &str)]) -> Vec<u8> {
        // attachments: (filename, content type, base64 body)
        let mut out = String::from(
            "From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n\
             Message-ID: <same@example.com>\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n\
             --outer\r\nContent-Type: multipart/alternative; boundary=\"alt\"\r\n\r\n\
             --alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n",
        );
        out.push_str(text);
        out.push_str("\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n");
        out.push_str(html);
        out.push_str("\r\n--alt--\r\n");
        for (name, ctype, body) in attachments {
            out.push_str(&format!(
                "--outer\r\nContent-Type: {ctype}; name=\"{name}\"\r\n\
                 Content-Disposition: attachment; filename=\"{name}\"\r\n\
                 Content-Transfer-Encoding: base64\r\n\r\n{body}\r\n"
            ));
        }
        out.push_str("--outer--\r\n");
        out.into_bytes()
    }

    fn hash_of(raw: &[u8]) -> String {
        let parser = MessageParser::default();
        parse_message(
            &parser,
            raw,
            1,
            "INBOX",
            raw.len() as u32,
            false,
            false,
            false,
            None,
        )
        .unwrap()
        .content_hash
    }

    #[test]
    fn content_hash_differs_when_only_attachment_bytes_differ() {
        // Same name, type and size ("AAAA" and "BBBB" both decode to 3 bytes).
        let a = mime(
            "t",
            "<p>t</p>",
            &[("invoice.pdf", "application/pdf", "AAAA")],
        );
        let b = mime(
            "t",
            "<p>t</p>",
            &[("invoice.pdf", "application/pdf", "BBBB")],
        );
        assert_ne!(hash_of(&a), hash_of(&b));
    }

    #[test]
    fn content_hash_is_equal_for_identical_content() {
        let a = mime(
            "t",
            "<p>t</p>",
            &[("invoice.pdf", "application/pdf", "AAAA")],
        );
        assert_eq!(hash_of(&a), hash_of(&a.clone()));
        assert_eq!(hash_of(&a).len(), 64);
    }

    #[test]
    fn content_hash_differs_when_only_the_text_or_html_part_differs() {
        let base = mime("pay to A", "<p>x</p>", &[]);
        assert_ne!(hash_of(&base), hash_of(&mime("pay to B", "<p>x</p>", &[])));
        assert_ne!(hash_of(&base), hash_of(&mime("pay to A", "<p>y</p>", &[])));
    }

    #[test]
    fn content_hash_differs_when_only_the_attachment_name_differs() {
        let a = mime(
            "t",
            "<p>t</p>",
            &[("invoice.pdf", "application/pdf", "AAAA")],
        );
        let b = mime(
            "t",
            "<p>t</p>",
            &[("invoice.pdf.exe", "application/pdf", "AAAA")],
        );
        assert_ne!(hash_of(&a), hash_of(&b));
    }

    #[test]
    fn content_hash_keeps_text_and_html_apart() {
        // "ab"+"c" and "a"+"bc" concatenate equally.
        assert_ne!(
            hash_of(&mime("ab", "c", &[])),
            hash_of(&mime("a", "bc", &[]))
        );
    }

    #[test]
    fn content_hash_ignores_the_mime_section_of_an_attachment() {
        // The same mail filed in another folder can have a different MIME
        // structure, which gives the attachment another part id.
        let flat = mime("t", "<p>t</p>", &[("a.pdf", "application/pdf", "AAAA")]);
        let wrapped = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n\
            Message-ID: <same@example.com>\r\nMIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"top\"\r\n\r\n\
            --top\r\nContent-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n\
            --outer\r\nContent-Type: multipart/alternative; boundary=\"alt\"\r\n\r\n\
            --alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nt\r\n\
            --alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>t</p>\r\n--alt--\r\n\
            --outer\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\n\
            Content-Disposition: attachment; filename=\"a.pdf\"\r\n\
            Content-Transfer-Encoding: base64\r\n\r\nAAAA\r\n--outer--\r\n--top--\r\n";
        assert_eq!(hash_of(&flat), hash_of(wrapped));
    }

    // INTERNALDATE as the raw fetch path reads it (RFC 3501 §2.3.3,
    // date-time = date-day-fixed "-" date-month "-" date-year SP time SP zone).
    #[test]
    fn imap_date_converts_to_unix_time() {
        assert_eq!(
            parse_imap_date("16-Feb-2026 12:00:00 +0000"),
            Some(1771243200)
        );
        assert_eq!(parse_imap_date("01-Jan-1970 00:00:00 +0000"), Some(0));
        // leap day and a century leap year
        assert_eq!(
            parse_imap_date("29-Feb-2024 23:59:59 +0000"),
            Some(1709251199)
        );
        assert_eq!(
            parse_imap_date("01-Mar-2000 00:00:00 +0000"),
            Some(951868800)
        );
    }

    #[test]
    fn imap_date_applies_the_zone_offset() {
        assert_eq!(
            parse_imap_date("16-Feb-2026 12:00:00 +0100"),
            Some(1771239600)
        );
        assert_eq!(
            parse_imap_date("16-Feb-2026 12:00:00 -0500"),
            Some(1771261200)
        );
        assert_eq!(
            parse_imap_date("31-Dec-2025 23:59:59 +0530"),
            Some(1767205799)
        );
    }

    #[test]
    fn imap_date_accepts_a_space_padded_day() {
        // date-day-fixed pads a single digit day with a space
        assert_eq!(
            parse_imap_date(" 1-Feb-2026 00:00:00 +0000"),
            Some(1769904000)
        );
    }

    #[test]
    fn imap_date_rejects_garbage() {
        assert_eq!(parse_imap_date(""), None);
        assert_eq!(parse_imap_date("not a date"), None);
        assert_eq!(parse_imap_date("16-Foo-2026 12:00:00 +0000"), None);
    }

    #[test]
    fn internal_date_is_read_from_a_fetch_line() {
        let line = "* 1 FETCH (UID 7 INTERNALDATE \"16-Feb-2026 12:00:00 +0000\" FLAGS (\\Seen))";
        assert_eq!(extract_internal_date(line), Some(1771243200));
        assert_eq!(extract_internal_date("* 1 FETCH (UID 7)"), None);
    }
}
