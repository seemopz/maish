//! Per-account pool of authenticated IMAP sessions.
//!
//! Every `imap_*` command used to open a TCP + TLS + LOGIN sequence of its own.
//! On a slow or lossy link that costs seconds per command, and a dropped SYN
//! stalls for the whole TCP connect timeout. The pool keeps a few idle sessions
//! per account so consecutive commands reuse one connection.
//!
//! Rules that keep reuse safe:
//! - A session is returned to the pool only through [`Lease::release`]. Dropping
//!   a lease (every `?` on an error path does) discards the session, because an
//!   error in the middle of a response can leave the protocol state unusable.
//! - A session idle for longer than `validate_after` is probed with `NOOP`
//!   before reuse; one idle for longer than `max_idle` is dropped.
//! - Nothing is retried here. `move`, `delete` and `append` are not idempotent,
//!   so a failed command is reported and the next call connects afresh.
//! - The password or token is held only as a SHA-256 digest, in memory.

use std::collections::HashMap;
use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::client as imap_client;
use super::types::ImapConfig;

/// Idle sessions kept per account.
const MAX_IDLE_PER_ACCOUNT: usize = 2;
/// Idle time after which a session is probed with `NOOP` before reuse.
const VALIDATE_AFTER: Duration = Duration::from_secs(20);
/// Idle time after which a session is discarded (server idle timeouts, NAT).
const MAX_IDLE: Duration = Duration::from_secs(5 * 60);
/// Upper bound for the `NOOP` probe.
const NOOP_TIMEOUT: Duration = Duration::from_secs(5);

/// How the pool opens and probes sessions. Lets tests run without a network.
pub(crate) trait Backend: Send + Sync + 'static {
    type Session: Send + 'static;

    fn connect(
        &self,
        config: &ImapConfig,
    ) -> impl Future<Output = Result<Self::Session, String>> + Send;

    fn noop(&self, session: &mut Self::Session) -> impl Future<Output = Result<(), String>> + Send;
}

/// Opens real sessions through `imap::client`.
pub(crate) struct ClientBackend;

impl Backend for ClientBackend {
    type Session = imap_client::ImapSession;

    async fn connect(&self, config: &ImapConfig) -> Result<Self::Session, String> {
        imap_client::connect(config).await
    }

    async fn noop(&self, session: &mut Self::Session) -> Result<(), String> {
        session
            .noop()
            .await
            .map_err(|e| format!("NOOP failed: {e}"))
    }
}

/// The pool used by the Tauri commands.
pub(crate) type ImapPool = Pool<ClientBackend>;

impl ImapPool {
    pub fn new() -> Self {
        Pool::with_backend(ClientBackend)
    }
}

/// Everything that identifies an account except the secret.
#[derive(Clone, PartialEq, Eq, Hash)]
struct AccountId {
    host: String,
    port: u16,
    security: String,
    username: String,
    auth_method: String,
    accept_invalid_certs: bool,
}

impl AccountId {
    fn of(config: &ImapConfig) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            security: config.security.clone(),
            username: config.username.clone(),
            auth_method: config.auth_method.clone(),
            accept_invalid_certs: config.accept_invalid_certs,
        }
    }
}

type SecretHash = [u8; 32];

fn hash_secret(secret: &str) -> SecretHash {
    Sha256::digest(secret.as_bytes()).into()
}

struct AccountSlot<S> {
    /// Digest of the secret the idle sessions logged in with.
    secret: SecretHash,
    /// Oldest first; the most recently used session is reused first.
    idle: Vec<(S, Instant)>,
}

struct Shared<B: Backend> {
    backend: B,
    accounts: Mutex<HashMap<AccountId, AccountSlot<B::Session>>>,
    max_idle_per_account: usize,
    validate_after: Duration,
    max_idle: Duration,
    noop_timeout: Duration,
}

pub(crate) struct Pool<B: Backend> {
    shared: Arc<Shared<B>>,
}

impl<B: Backend> Pool<B> {
    pub fn with_backend(backend: B) -> Self {
        Self::with_limits(
            backend,
            MAX_IDLE_PER_ACCOUNT,
            VALIDATE_AFTER,
            MAX_IDLE,
            NOOP_TIMEOUT,
        )
    }

    fn with_limits(
        backend: B,
        max_idle_per_account: usize,
        validate_after: Duration,
        max_idle: Duration,
        noop_timeout: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                backend,
                accounts: Mutex::new(HashMap::new()),
                max_idle_per_account,
                validate_after,
                max_idle,
                noop_timeout,
            }),
        }
    }

    /// Hand out an idle session for the account or connect a new one.
    ///
    /// No lock is held while a command runs, so a slow fetch never blocks
    /// another command for the same account; it just uses a second session.
    pub async fn acquire(&self, config: &ImapConfig) -> Result<Lease<B>, String> {
        let id = AccountId::of(config);
        let secret = hash_secret(&config.password);

        loop {
            let Some((mut session, idle_since)) = self.take_idle(&id, secret) else {
                let session = self.shared.backend.connect(config).await?;
                return Ok(self.lease(id, secret, session));
            };

            if idle_since.elapsed() > self.shared.validate_after {
                let probe = tokio::time::timeout(
                    self.shared.noop_timeout,
                    self.shared.backend.noop(&mut session),
                )
                .await;
                if !matches!(probe, Ok(Ok(()))) {
                    log::debug!("Discarding idle IMAP session that failed its NOOP probe");
                    continue;
                }
            }
            return Ok(self.lease(id, secret, session));
        }
    }

    fn take_idle(&self, id: &AccountId, secret: SecretHash) -> Option<(B::Session, Instant)> {
        let mut accounts = self
            .shared
            .accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // Drop sessions that sat idle too long, for every account.
        let max_idle = self.shared.max_idle;
        for slot in accounts.values_mut() {
            slot.idle.retain(|(_, since)| since.elapsed() <= max_idle);
        }
        accounts.retain(|_, slot| !slot.idle.is_empty());

        let slot = accounts.get_mut(id)?;
        if slot.secret != secret {
            // The password or token changed: those sessions are of no use.
            accounts.remove(id);
            return None;
        }
        slot.idle.pop()
    }

    fn lease(&self, id: AccountId, secret: SecretHash, session: B::Session) -> Lease<B> {
        Lease {
            shared: Arc::clone(&self.shared),
            id,
            secret,
            session: Some(session),
        }
    }

    #[cfg(test)]
    fn idle_count(&self, config: &ImapConfig) -> usize {
        let accounts = self
            .shared
            .accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        accounts
            .get(&AccountId::of(config))
            .map_or(0, |slot| slot.idle.len())
    }
}

/// A session on loan from the pool. Dropping it discards the session; call
/// [`Lease::release`] after a command succeeded to keep it for reuse.
pub(crate) struct Lease<B: Backend> {
    shared: Arc<Shared<B>>,
    id: AccountId,
    secret: SecretHash,
    session: Option<B::Session>,
}

impl<B: Backend> Lease<B> {
    pub fn release(mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        let mut accounts = self
            .shared
            .accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let slot = accounts
            .entry(self.id.clone())
            .or_insert_with(|| AccountSlot {
                secret: self.secret,
                idle: Vec::new(),
            });
        // Another session already logged in with a newer secret: this one is stale.
        if slot.secret != self.secret {
            if slot.idle.is_empty() {
                slot.secret = self.secret;
            } else {
                return;
            }
        }
        if slot.idle.len() < self.shared.max_idle_per_account {
            slot.idle.push((session, Instant::now()));
        }
    }
}

impl<B: Backend> Deref for Lease<B> {
    type Target = B::Session;

    fn deref(&self) -> &Self::Target {
        self.session
            .as_ref()
            .expect("lease holds a session until released")
    }
}

impl<B: Backend> DerefMut for Lease<B> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.session
            .as_mut()
            .expect("lease holds a session until released")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FakeSession {
        alive: Arc<AtomicBool>,
    }

    #[derive(Default)]
    struct FakeBackend {
        connects: AtomicUsize,
        noops: AtomicUsize,
        /// Liveness flag of every session handed out, in connect order.
        sessions: Mutex<Vec<Arc<AtomicBool>>>,
    }

    impl Backend for Arc<FakeBackend> {
        type Session = FakeSession;

        async fn connect(&self, _config: &ImapConfig) -> Result<FakeSession, String> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            let alive = Arc::new(AtomicBool::new(true));
            self.sessions.lock().unwrap().push(alive.clone());
            Ok(FakeSession { alive })
        }

        async fn noop(&self, session: &mut FakeSession) -> Result<(), String> {
            self.noops.fetch_add(1, Ordering::SeqCst);
            if session.alive.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("connection reset".to_string())
            }
        }
    }

    fn config(password: &str) -> ImapConfig {
        ImapConfig {
            host: "imap.example.test".to_string(),
            port: 993,
            security: "tls".to_string(),
            username: "user@example.test".to_string(),
            password: password.to_string(),
            auth_method: "password".to_string(),
            accept_invalid_certs: false,
        }
    }

    fn pool_with(
        validate_after: Duration,
        max_idle: Duration,
    ) -> (Pool<Arc<FakeBackend>>, Arc<FakeBackend>) {
        let backend = Arc::new(FakeBackend::default());
        let pool = Pool::with_limits(
            backend.clone(),
            MAX_IDLE_PER_ACCOUNT,
            validate_after,
            max_idle,
            NOOP_TIMEOUT,
        );
        (pool, backend)
    }

    fn pool() -> (Pool<Arc<FakeBackend>>, Arc<FakeBackend>) {
        pool_with(VALIDATE_AFTER, MAX_IDLE)
    }

    #[tokio::test]
    async fn reuses_one_connection_for_consecutive_commands() {
        let (pool, backend) = pool();
        let cfg = config("pw");
        for _ in 0..5 {
            pool.acquire(&cfg).await.unwrap().release();
        }
        assert_eq!(backend.connects.load(Ordering::SeqCst), 1);
        assert_eq!(backend.noops.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dropped_lease_discards_the_session() {
        let (pool, backend) = pool();
        let cfg = config("pw");
        drop(pool.acquire(&cfg).await.unwrap());
        assert_eq!(pool.idle_count(&cfg), 0);
        pool.acquire(&cfg).await.unwrap().release();
        assert_eq!(backend.connects.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn changed_password_does_not_reuse_the_old_session() {
        let (pool, backend) = pool();
        pool.acquire(&config("old")).await.unwrap().release();
        pool.acquire(&config("new")).await.unwrap().release();
        assert_eq!(backend.connects.load(Ordering::SeqCst), 2);
        assert_eq!(pool.idle_count(&config("new")), 1);
        // The old one is gone for good: asking with the old secret connects again.
        pool.acquire(&config("old")).await.unwrap().release();
        assert_eq!(backend.connects.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn stale_session_returned_after_a_password_change_is_dropped() {
        let (pool, _backend) = pool();
        let stale = pool.acquire(&config("old")).await.unwrap();
        pool.acquire(&config("new")).await.unwrap().release();
        stale.release();
        assert_eq!(pool.idle_count(&config("new")), 1);
    }

    #[tokio::test]
    async fn different_accounts_do_not_share_sessions() {
        let (pool, backend) = pool();
        let a = config("pw");
        let mut b = config("pw");
        b.username = "other@example.test".to_string();
        pool.acquire(&a).await.unwrap().release();
        pool.acquire(&b).await.unwrap().release();
        assert_eq!(backend.connects.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_commands_get_separate_sessions_and_at_most_two_stay_idle() {
        let (pool, backend) = pool();
        let cfg = config("pw");
        let first = pool.acquire(&cfg).await.unwrap();
        let second = pool.acquire(&cfg).await.unwrap();
        let third = pool.acquire(&cfg).await.unwrap();
        assert_eq!(backend.connects.load(Ordering::SeqCst), 3);
        first.release();
        second.release();
        third.release();
        assert_eq!(pool.idle_count(&cfg), 2);
    }

    #[tokio::test]
    async fn idle_session_failing_noop_is_replaced() {
        let (pool, backend) = pool_with(Duration::ZERO, MAX_IDLE);
        let cfg = config("pw");
        pool.acquire(&cfg).await.unwrap().release();
        backend.sessions.lock().unwrap()[0].store(false, Ordering::SeqCst);

        pool.acquire(&cfg).await.unwrap().release();
        assert_eq!(backend.noops.load(Ordering::SeqCst), 1);
        assert_eq!(backend.connects.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn healthy_idle_session_passes_noop_and_is_reused() {
        let (pool, backend) = pool_with(Duration::ZERO, MAX_IDLE);
        let cfg = config("pw");
        pool.acquire(&cfg).await.unwrap().release();
        pool.acquire(&cfg).await.unwrap().release();
        assert_eq!(backend.noops.load(Ordering::SeqCst), 1);
        assert_eq!(backend.connects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn session_idle_past_the_limit_is_dropped_without_probe() {
        let (pool, backend) = pool_with(VALIDATE_AFTER, Duration::ZERO);
        let cfg = config("pw");
        pool.acquire(&cfg).await.unwrap().release();
        tokio::time::sleep(Duration::from_millis(5)).await;
        pool.acquire(&cfg).await.unwrap().release();
        assert_eq!(backend.noops.load(Ordering::SeqCst), 0);
        assert_eq!(backend.connects.load(Ordering::SeqCst), 2);
    }
}
