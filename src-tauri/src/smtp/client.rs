use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use lettre::{
    transport::smtp::{
        authentication::{Credentials, Mechanism},
        client::{Tls, TlsParametersBuilder},
    },
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
};

use super::types::{SmtpConfig, SmtpSendResult};

/// Decode a base64url-encoded string (Gmail format) to raw bytes.
fn decode_base64url(input: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

/// Build an async SMTP transport from the given config.
fn build_transport(
    config: &SmtpConfig,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let credentials = Credentials::new(config.username.clone(), config.password.clone());

    // For OAuth2, force XOAUTH2 mechanism; for password, use default mechanisms
    let auth_mechanisms = if config.auth_method == "oauth2" {
        vec![Mechanism::Xoauth2]
    } else {
        vec![Mechanism::Plain, Mechanism::Login]
    };

    let transport = match config.security.as_str() {
        "tls" => {
            // Implicit TLS (typically port 465)
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
                .map_err(|e| format!("SMTP relay error: {}", e))?
                .port(config.port)
                .credentials(credentials)
                .authentication(auth_mechanisms);

            if config.accept_invalid_certs {
                let tls_params = TlsParametersBuilder::new(config.host.clone())
                    .dangerous_accept_invalid_certs(true)
                    .dangerous_accept_invalid_hostnames(true)
                    .build()
                    .map_err(|e| format!("SMTP TLS params error: {}", e))?;
                // `relay()` set `Tls::Wrapper`; keep it. `Tls::Required` would
                // switch to STARTTLS and never handshake on port 465.
                builder = builder.tls(Tls::Wrapper(tls_params));
            }

            builder.build()
        }
        "starttls" => {
            // STARTTLS (typically port 587)
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
                .map_err(|e| format!("SMTP STARTTLS error: {}", e))?
                .port(config.port)
                .credentials(credentials)
                .authentication(auth_mechanisms);

            if config.accept_invalid_certs {
                let tls_params = TlsParametersBuilder::new(config.host.clone())
                    .dangerous_accept_invalid_certs(true)
                    .dangerous_accept_invalid_hostnames(true)
                    .build()
                    .map_err(|e| format!("SMTP TLS params error: {}", e))?;
                builder = builder.tls(Tls::Required(tls_params));
            }

            builder.build()
        }
        "none" => {
            // Plain / no encryption (typically port 25) — not recommended
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
                .port(config.port)
                .credentials(credentials)
                .authentication(auth_mechanisms)
                .build()
        }
        // Never fall back to plaintext on a typo or a future setting: the
        // credentials would go out unencrypted.
        other => return Err(format!("Unknown SMTP security setting: {:?}", other)),
    };

    Ok(transport)
}

/// Extract an SMTP envelope (sender + recipients) from raw RFC 2822 bytes.
///
/// The envelope tells the SMTP server who the mail is from and who to deliver
/// it to, which is separate from the header fields visible to the recipient.
fn extract_envelope(raw: &[u8]) -> Result<lettre::address::Envelope, String> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or("Failed to parse email for envelope extraction")?;

    // Extract From address
    let from = message
        .from()
        .and_then(|list| list.first())
        .and_then(|addr| addr.address())
        .ok_or("No From address found in email")?;

    let from_addr: lettre::Address = from
        .parse()
        .map_err(|e| format!("Invalid From address '{}': {}", from, e))?;

    // Collect all recipient addresses (To, Cc, Bcc)
    let mut recipients: Vec<lettre::Address> = Vec::new();

    if let Some(to_list) = message.to() {
        for addr in to_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(cc_list) = message.cc() {
        for addr in cc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(bcc_list) = message.bcc() {
        for addr in bcc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if recipients.is_empty() {
        return Err("No recipients found in email".to_string());
    }

    lettre::address::Envelope::new(Some(from_addr), recipients)
        .map_err(|e| format!("Envelope error: {}", e))
}

/// Remove the Bcc header fields from a message's header block.
///
/// The composer writes a real `Bcc:` field into the MIME source, which is how
/// `extract_envelope` learns who to hand the server as RCPT. lettre's
/// `send_raw` passes the bytes to DATA unchanged (`AsyncSmtpTransport::send_raw`
/// forwards them to `Connection::send`, which only dot-stuffs), so a field left
/// in place is delivered to everyone and tells each recipient who was blind
/// copied. RFC 5322 section 3.6.3 has the field removed before transmission.
///
/// Only the header block is touched — everything from the first empty line on
/// is content, where a quoted mail can easily contain a line that looks like a
/// field. Folded continuation lines (section 2.2.3) belong to the field above
/// them and go with it.
fn strip_bcc_headers(raw: &[u8]) -> Vec<u8> {
    /// Field names that name blind recipients (RFC 5322 sections 3.6.3, 3.6.6).
    const BLIND: [&str; 2] = ["bcc", "resent-bcc"];

    // The header block ends at the first empty line. Both endings are accepted:
    // the message is built with CRLF, but nothing downstream guarantees it.
    let header_len = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 2)
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| i + 1))
        .unwrap_or(raw.len());

    let (headers, rest) = raw.split_at(header_len);

    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut dropping = false;

    for line in headers.split_inclusive(|&b| b == b'\n') {
        let is_continuation = matches!(line.first(), Some(b' ') | Some(b'\t'));

        if !is_continuation {
            let name = line.split(|&b| b == b':').next().unwrap_or(&[]);
            dropping = std::str::from_utf8(name)
                .map(|n| BLIND.iter().any(|blind| n.eq_ignore_ascii_case(blind)))
                .unwrap_or(false);
        }

        if !dropping {
            out.extend_from_slice(line);
        }
    }

    out.extend_from_slice(rest);
    out
}

/// Send a pre-built RFC 2822 email via SMTP.
///
/// The `raw_email_base64url` parameter is the full email message encoded as
/// base64url (the same encoding Gmail uses: `+` → `-`, `/` → `_`, no padding).
/// The function decodes it, extracts the envelope from headers, and sends it.
pub async fn send_raw_email(
    config: &SmtpConfig,
    raw_email_base64url: &str,
) -> Result<SmtpSendResult, String> {
    let raw_bytes = decode_base64url(raw_email_base64url)?;
    // The envelope has to be read while the Bcc field is still there — the
    // blind recipients exist nowhere else — and the field has to be gone
    // before the same bytes are handed to DATA.
    let envelope = extract_envelope(&raw_bytes)?;
    let raw_bytes = strip_bcc_headers(&raw_bytes);
    let transport = build_transport(config)?;

    transport
        .send_raw(&envelope, &raw_bytes)
        .await
        .map(|_response| SmtpSendResult {
            success: true,
            message: "Email sent successfully".to_string(),
        })
        .map_err(|e| format!("SMTP send error: {}", e))
}

/// Test SMTP connectivity by connecting, authenticating, and disconnecting.
pub async fn test_connection(config: &SmtpConfig) -> Result<SmtpSendResult, String> {
    let transport = build_transport(config)?;

    transport
        .test_connection()
        .await
        .map(|success| SmtpSendResult {
            success,
            message: if success {
                "Connection successful".to_string()
            } else {
                "Connection failed".to_string()
            },
        })
        .map_err(|e| format!("SMTP test error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_security(security: &str) -> SmtpConfig {
        SmtpConfig {
            host: "smtp.example.com".to_string(),
            port: 587,
            security: security.to_string(),
            username: "user".to_string(),
            password: "secret".to_string(),
            auth_method: "password".to_string(),
            accept_invalid_certs: false,
        }
    }

    #[test]
    fn test_build_transport_rejects_unknown_security() {
        for value in ["", "ssl", "TLS", "starttls ", "stattls", "opportunistic"] {
            let result = build_transport(&config_with_security(value));
            let err = result.err().unwrap_or_else(|| {
                panic!("security {:?} must not produce a transport", value)
            });
            assert!(err.contains("Unknown SMTP security"), "got: {}", err);
        }
    }

    #[test]
    fn test_build_transport_accepts_known_security_values() {
        for value in ["tls", "starttls", "none"] {
            assert!(
                build_transport(&config_with_security(value)).is_ok(),
                "security {:?} should build",
                value
            );
        }
    }

    #[test]
    fn test_decode_base64url_valid() {
        // "Hello" in base64url
        let encoded = "SGVsbG8";
        let decoded = decode_base64url(encoded).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn test_decode_base64url_invalid() {
        let result = decode_base64url("!!!invalid!!!");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Base64 decode error"));
    }

    #[test]
    fn test_extract_envelope_valid() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nCc: carol@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        // Envelope should have from and 2 recipients (To + Cc)
        assert!(envelope.from().is_some());
        assert_eq!(envelope.to().len(), 2);
    }

    #[test]
    fn test_extract_envelope_no_from() {
        let raw = b"To: bob@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No From address"));
    }

    #[test]
    fn test_extract_envelope_no_recipients() {
        let raw = b"From: alice@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No recipients found"));
    }

    #[test]
    fn test_extract_envelope_with_bcc() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        assert_eq!(envelope.to().len(), 2);
    }

    // The composer writes a real Bcc header into the MIME source so that
    // extract_envelope can build the RCPT list from it. lettre's send_raw
    // hands the bytes to DATA untouched, so the header has to come back out
    // before the message goes on the wire — otherwise every recipient is told
    // who was blind-copied.

    #[test]
    fn test_strip_bcc_removes_the_header() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\n\r\nBody";
        let stripped = strip_bcc_headers(raw);
        let text = String::from_utf8(stripped).unwrap();

        assert!(!text.contains("Bcc:"));
        assert!(!text.contains("secret@example.com"));
        assert!(text.contains("To: bob@example.com"));
        assert!(text.contains("Subject: Test"));
        assert!(text.ends_with("\r\n\r\nBody"));
    }

    #[test]
    fn test_strip_bcc_removes_folded_continuation_lines() {
        // RFC 5322 section 2.2.3: a long field is folded onto lines that
        // begin with whitespace. Dropping only the first line would leave the
        // rest of the address list behind as a header of its own.
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com,\r\n\tother@example.com,\r\n hidden@example.com\r\nSubject: Test\r\n\r\nBody";
        let text = String::from_utf8(strip_bcc_headers(raw)).unwrap();

        assert!(!text.contains("secret@example.com"));
        assert!(!text.contains("other@example.com"));
        assert!(!text.contains("hidden@example.com"));
        assert!(text.contains("Subject: Test"));
    }

    #[test]
    fn test_strip_bcc_leaves_the_body_alone() {
        // A line in the body that happens to look like a header is content,
        // not a field, and quoting a mail can easily produce one.
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\n\r\nBcc: this is body text\r\nsecret@example.com";
        let text = String::from_utf8(strip_bcc_headers(raw)).unwrap();

        assert!(text.contains("Bcc: this is body text"));
        assert!(text.contains("secret@example.com"));
    }

    #[test]
    fn test_strip_bcc_keeps_headers_that_merely_end_in_bcc() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nX-Original-Bcc: kept@example.com\r\nSubject: Test\r\n\r\nBody";
        let text = String::from_utf8(strip_bcc_headers(raw)).unwrap();

        assert!(text.contains("X-Original-Bcc: kept@example.com"));
    }

    #[test]
    fn test_strip_bcc_is_case_insensitive_and_takes_resent_bcc() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBCC: secret@example.com\r\nResent-Bcc: alsosecret@example.com\r\nSubject: Test\r\n\r\nBody";
        let text = String::from_utf8(strip_bcc_headers(raw)).unwrap();

        assert!(!text.contains("secret@example.com"));
        assert!(!text.contains("alsosecret@example.com"));
        assert!(text.contains("Subject: Test"));
    }

    #[test]
    fn test_strip_bcc_handles_bare_lf_line_endings() {
        let raw = b"From: alice@example.com\nTo: bob@example.com\nBcc: secret@example.com\nSubject: Test\n\nBody";
        let text = String::from_utf8(strip_bcc_headers(raw)).unwrap();

        assert!(!text.contains("secret@example.com"));
        assert!(text.contains("Subject: Test"));
        assert!(text.ends_with("\n\nBody"));
    }

    #[test]
    fn test_strip_bcc_leaves_a_message_without_one_untouched() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test\r\n\r\nBody";
        assert_eq!(strip_bcc_headers(raw), raw.to_vec());
    }

    #[test]
    fn test_envelope_is_taken_before_the_header_is_stripped() {
        // The order in send_raw_email matters: the blind recipients only
        // exist in the header, so the RCPT list has to be built first.
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\n\r\nBody";

        let envelope = extract_envelope(raw).unwrap();
        assert_eq!(envelope.to().len(), 2, "bcc recipient belongs in the envelope");

        let stripped = strip_bcc_headers(raw);
        let envelope_after = extract_envelope(&stripped).unwrap();
        assert_eq!(
            envelope_after.to().len(),
            1,
            "stripping first would lose the blind recipient entirely"
        );
    }
}

/// Transport tests against a local TLS listener with a self-signed certificate.
#[cfg(test)]
mod tls_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    /// Create a throwaway self-signed certificate for `localhost` with the
    /// `openssl` command line tool and return it as a PKCS#12 bundle (password
    /// `test`). Generated per run so no key material lives in the repository.
    #[rustfmt::skip]
    fn self_signed_p12() -> Vec<u8> {
        // Both tests call this concurrently, so each call gets its own directory.
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("maish-smtp-tls-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let (key, cert, p12) = (dir.join("k.pem"), dir.join("c.pem"), dir.join("b.p12"));

        let run = |args: &[&str]| {
            let out = std::process::Command::new("openssl")
                .args(args)
                .output()
                .expect("the openssl command line tool is required for this test");
            assert!(
                out.status.success(),
                "openssl {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        let path = |p: &std::path::Path| p.to_str().unwrap().to_string();

        // Explicit config: LibreSSL (macOS /usr/bin/openssl) ships none.
        let conf = dir.join("req.cnf");
        std::fs::write(
            &conf,
            "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n\
             [dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\n",
        )
        .unwrap();
        run(&[
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-config", &path(&conf), "-keyout", &path(&key), "-out", &path(&cert),
        ]);
        run(&[
            "pkcs12", "-export", "-inkey", &path(&key), "-in", &path(&cert),
            "-passout", "pass:test", "-out", &path(&p12),
        ]);

        let bytes = std::fs::read(&p12).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        bytes
    }

    fn config(port: u16, security: &str, accept_invalid_certs: bool) -> SmtpConfig {
        SmtpConfig {
            host: "localhost".to_string(),
            port,
            security: security.to_string(),
            username: "user".to_string(),
            password: "secret".to_string(),
            auth_method: "password".to_string(),
            accept_invalid_certs,
        }
    }

    /// Accepts one connection, expects a TLS handshake straight away (implicit
    /// TLS, as on port 465) and then speaks just enough SMTP for
    /// `test_connection`. Returns whether the handshake succeeded.
    async fn serve_implicit_tls_once(listener: TcpListener) -> bool {
        let identity = native_tls::Identity::from_pkcs12(&self_signed_p12(), "test").unwrap();
        let acceptor =
            tokio_native_tls::TlsAcceptor::from(native_tls::TlsAcceptor::new(identity).unwrap());

        let (socket, _) = listener.accept().await.unwrap();
        let handshake = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket));
        let Ok(Ok(stream)) = handshake.await else {
            return false;
        };

        let mut stream = BufReader::new(stream);
        let _ = stream.get_mut().write_all(b"220 localhost ESMTP\r\n").await;
        let mut line = String::new();
        while let Ok(n) = stream.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            let reply: &[u8] = if line.starts_with("EHLO") {
                b"250-localhost\r\n250 AUTH PLAIN LOGIN\r\n"
            } else if line.starts_with("AUTH") {
                b"235 2.7.0 Authenticated\r\n"
            } else if line.starts_with("QUIT") {
                b"221 Bye\r\n"
            } else {
                b"250 OK\r\n"
            };
            let quit = line.starts_with("QUIT");
            if stream.get_mut().write_all(reply).await.is_err() || quit {
                break;
            }
            line.clear();
        }
        true
    }

    async fn probe(config: &SmtpConfig) -> Option<Result<SmtpSendResult, String>> {
        tokio::time::timeout(Duration::from_secs(10), test_connection(config))
            .await
            .ok()
    }

    #[tokio::test]
    async fn test_implicit_tls_accepts_self_signed_certificate_when_allowed() {
        // Port 465 style: the server speaks TLS from the first byte. Before
        // the fix the client downgraded to STARTTLS-required, waited for a
        // plaintext greeting and never started a handshake.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_implicit_tls_once(listener));

        let result = probe(&config(port, "tls", true)).await;

        assert!(
            matches!(&result, Some(Ok(r)) if r.success),
            "implicit TLS with accept_invalid_certs must connect, got: {:?}",
            result.map(|r| r.map(|r| r.message))
        );
        assert!(server.await.unwrap(), "server never saw a TLS handshake");
    }

    #[tokio::test]
    async fn test_implicit_tls_rejects_self_signed_certificate_by_default() {
        // The opt-in is what allows the certificate; without it the same
        // server must be refused.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_implicit_tls_once(listener));

        let result = probe(&config(port, "tls", false)).await;

        assert!(
            !matches!(&result, Some(Ok(r)) if r.success),
            "a self-signed certificate must not be accepted without the opt-in"
        );
        server.abort();
    }
}
