use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
    pub state: String,
}

/// Cancels the callback server of a login that was started earlier.
///
/// A login the user walked away from sits in accept() for five minutes holding
/// the port. Since the redirect URI names one fixed port, that blocks every
/// retry in the meantime, so starting a new login ends the old one first.
static CANCEL_PREVIOUS: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// How long to keep trying the port after cancelling a previous login, so the
/// listener it was holding has a moment to come down.
const BIND_RETRY_TOTAL: Duration = Duration::from_millis(1_000);
const BIND_RETRY_STEP: Duration = Duration::from_millis(50);

/// Bind the OAuth callback port — that port and no other.
///
/// The redirect URI handed to the provider is built from a fixed port
/// (OAUTH_CALLBACK_PORT on the TypeScript side), so a server listening
/// anywhere else is never called: the browser sends the code to the port in
/// the URI and this end waits out its timeout on a port nobody visits. Falling
/// back to a neighbouring port turned a busy port into a login that hangs for
/// five minutes and then fails without saying why.
async fn bind_callback_port(port: u16) -> Result<TcpListener, String> {
    let deadline = std::time::Instant::now() + BIND_RETRY_TOTAL;

    loop {
        let err = match TcpListener::bind(format!("127.0.0.1:{}", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => e,
        };
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Could not listen on port {port} for the sign-in redirect ({err}). \
                 Another program is using it — close it and try again."
            ));
        }
        tokio::time::sleep(BIND_RETRY_STEP).await;
    }
}

/// Binds the localhost port the OAuth redirect names and waits for the
/// callback.
#[tauri::command]
pub async fn start_oauth_server(port: u16, state: String) -> Result<OAuthResult, String> {
    // End a login that is still holding the port, then take it over.
    let (cancel_tx, cancel_rx) = oneshot::channel();
    if let Some(previous) = CANCEL_PREVIOUS
        .lock()
        .map_err(|_| "OAuth server lock poisoned".to_string())?
        .replace(cancel_tx)
    {
        let _ = previous.send(());
    }

    let listener = bind_callback_port(port).await?;

    log::info!("OAuth callback server listening on port {}", port);

    // Wait for exactly one connection (the redirect from the provider) with a
    // 5-minute timeout, or until a newer login takes over.
    let accepted = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(300), listener.accept()) => result,
        _ = cancel_rx => return Err("Sign-in was restarted".to_string()),
    };

    let (mut stream, _) = accepted
        .map_err(|_| "OAuth timed out — please try again".to_string())?
        .map_err(|e| format!("Failed to accept: {}", e))?;

    // Read the HTTP request
    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Extract query string from GET request line
    let (code, returned_state) = parse_auth_code_and_state(&request)?;

    // Validate state parameter (CSRF protection)
    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF attack".to_string());
    }

    // Send a success response to the browser
    let html = r#"<!DOCTYPE html>
<html>
<head><title>Maish</title></head>
<body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center;">
<h1 style="margin-bottom: 8px;">Account Connected!</h1>
<p style="opacity: 0.7;">You can close this tab and return to Maish.</p>
</div>
</body>
</html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );

    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    drop(listener);

    Ok(OAuthResult { code, state: returned_state })
}

fn parse_auth_code_and_state(request: &str) -> Result<(String, String), String> {
    let first_line = request.lines().next().ok_or("Empty request")?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or("No path in request")?;

    if path.contains("error=") {
        let params = parse_query_string(path);
        let error = params.get("error").cloned().unwrap_or_default();
        return Err(format!("OAuth error: {}", error));
    }

    let params = parse_query_string(path);
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "No auth code in redirect".to_string())?;
    let state = params
        .get("state")
        .cloned()
        .ok_or_else(|| "No state in redirect".to_string())?;
    Ok((code, state))
}

fn parse_query_string(path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if let Some(query) = path.split('?').nth(1) {
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
                params.insert(key.to_string(), urlencoding_decode(value));
            }
        }
    }
    params
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &s[i + 1..i + 3],
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
        } else {
            result.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

#[derive(Serialize, Deserialize)]
pub struct TokenExchangeResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub token_type: String,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// Exchange an OAuth authorization code for tokens via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_exchange_token(
    token_url: String,
    code: String,
    client_id: String,
    redirect_uri: String,
    code_verifier: Option<String>,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".to_string()),
    ];
    if let Some(verifier) = code_verifier {
        params.push(("code_verifier", verifier));
    }
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token exchange failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

/// Refresh an OAuth token via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_refresh_token(
    token_url: String,
    refresh_token: String,
    client_id: String,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token refresh failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The redirect URI the provider is given names one fixed port. A server
    /// on any other port is never called: the browser delivers the code where
    /// the URI says, and this end waits out its five-minute timeout on a port
    /// nobody visits, then fails with a timeout that says nothing about the
    /// real cause. Binding a neighbouring port therefore has to fail instead.
    #[tokio::test]
    async fn binds_the_port_it_was_asked_for() {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free_port = probe.local_addr().unwrap().port();
        drop(probe);

        let listener = bind_callback_port(free_port).await.unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), free_port);
    }

    #[tokio::test]
    async fn refuses_a_port_that_is_taken_rather_than_moving_to_another() {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();

        let result = bind_callback_port(port).await;

        assert!(result.is_err(), "a neighbouring port would never be called");
        let message = result.err().unwrap();
        assert!(
            message.contains(&port.to_string()),
            "the error should name the port so the cause is visible: {message}"
        );
    }

    #[tokio::test]
    async fn takes_the_port_once_the_previous_listener_lets_go() {
        // A login that is cancelled drops its listener; the retry window is
        // what lets the next attempt pick the port straight up rather than
        // reporting it busy.
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(occupied);
        });

        let listener = bind_callback_port(port).await.unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), port);
    }
}
