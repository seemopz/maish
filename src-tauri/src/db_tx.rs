//! Transactional SQLite access on a single, dedicated connection.
//!
//! Why this exists: `tauri-plugin-sql` runs every `execute()` against a sqlx
//! *pool* (`Pool::connect()`, i.e. up to 10 connections). Issuing
//! `BEGIN TRANSACTION`, the statements, and `COMMIT` as separate IPC calls
//! therefore spreads one logical transaction over several connections. The
//! connection that ran `BEGIN` keeps the write lock open indefinitely while the
//! others block on it, which deadlocks IMAP sync (see issue #240).
//!
//! The commands below all run on one `SqliteConnection` that is never shared
//! with the plugin's pool, so a transaction started by `db_tx_begin` is still
//! open when `db_tx_execute` and `db_tx_commit` arrive.
//!
//! Callers must serialise transactions themselves — `withTransaction()` in
//! `src/services/db/connection.ts` already does that with an async mutex.

use serde_json::{Map, Value as JsonValue};
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow, SqliteValueRef};
use sqlx::{Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef};
use std::path::PathBuf;
use std::str::FromStr;
use tokio::sync::Mutex;

/// Managed state: the dedicated connection, opened lazily on first use.
pub struct DbTxState {
    conn: Mutex<Option<SqliteConnection>>,
    path: Mutex<Option<PathBuf>>,
}

impl DbTxState {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            path: Mutex::new(None),
        }
    }

    /// Remember where the database lives. Called once during setup so the
    /// commands do not need an AppHandle.
    pub async fn set_path(&self, path: PathBuf) {
        *self.path.lock().await = Some(path);
    }
}

impl Default for DbTxState {
    fn default() -> Self {
        Self::new()
    }
}

/// Open the connection if it is not open yet, then run `f` on it.
async fn with_conn<T, F>(state: &DbTxState, f: F) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut SqliteConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    let mut guard = state.conn.lock().await;

    if guard.is_none() {
        let path = state
            .path
            .lock()
            .await
            .clone()
            .ok_or_else(|| "db_tx: database path not configured".to_string())?;

        let opts = SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
            .map_err(|e| format!("db_tx: bad connect options: {e}"))?
            .create_if_missing(false)
            // Matches the journal mode the plugin's pool already uses; readers
            // stay unblocked while this connection holds the write lock.
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(10));

        let conn = SqliteConnection::connect_with(&opts)
            .await
            .map_err(|e| format!("db_tx: connect failed: {e}"))?;
        *guard = Some(conn);
        log::info!("db_tx: opened dedicated transaction connection");
    }

    let conn = guard.as_mut().expect("connection just ensured");
    f(conn).await
}

/// Bind one JSON value to a query. Mirrors the subset of types the JS side
/// actually passes: null, bool, integer, float, string. Anything structured is
/// stored as its JSON text, which is what the plugin does too.
fn bind_params<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: Vec<JsonValue>,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for p in params {
        query = match p {
            JsonValue::Null => query.bind(None::<String>),
            JsonValue::Bool(b) => query.bind(b),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    query.bind(i)
                } else {
                    query.bind(n.as_f64().unwrap_or(0.0))
                }
            }
            JsonValue::String(s) => query.bind(s),
            other => query.bind(other.to_string()),
        };
    }
    query
}

/// Convert one result row into a JSON object, probing the column type.
fn row_to_json(row: &SqliteRow) -> Result<Map<String, JsonValue>, String> {
    let mut obj = Map::new();

    for (i, col) in row.columns().iter().enumerate() {
        let raw: SqliteValueRef = row
            .try_get_raw(i)
            .map_err(|e| format!("db_tx: column {i} unreadable: {e}"))?;

        let value = if raw.is_null() {
            JsonValue::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "BIGINT" => row
                    .try_get::<i64, _>(i)
                    .map(JsonValue::from)
                    .unwrap_or(JsonValue::Null),
                "REAL" | "DOUBLE" | "FLOAT" => row
                    .try_get::<f64, _>(i)
                    .map(JsonValue::from)
                    .unwrap_or(JsonValue::Null),
                "BLOB" => row
                    .try_get::<Vec<u8>, _>(i)
                    .map(|b| JsonValue::from(b.to_vec()))
                    .unwrap_or(JsonValue::Null),
                // TEXT and everything SQLite reports loosely.
                _ => row
                    .try_get::<String, _>(i)
                    .map(JsonValue::from)
                    .unwrap_or(JsonValue::Null),
            }
        };

        obj.insert(col.name().to_string(), value);
    }

    Ok(obj)
}

#[tauri::command]
pub async fn db_tx_begin(state: tauri::State<'_, DbTxState>) -> Result<(), String> {
    with_conn(&state, |conn| {
        Box::pin(async move {
            sqlx::query("BEGIN IMMEDIATE")
                .execute(conn)
                .await
                .map_err(|e| format!("db_tx: BEGIN failed: {e}"))?;
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_tx_commit(state: tauri::State<'_, DbTxState>) -> Result<(), String> {
    with_conn(&state, |conn| {
        Box::pin(async move {
            sqlx::query("COMMIT")
                .execute(conn)
                .await
                .map_err(|e| format!("db_tx: COMMIT failed: {e}"))?;
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_tx_rollback(state: tauri::State<'_, DbTxState>) -> Result<(), String> {
    with_conn(&state, |conn| {
        Box::pin(async move {
            // Ignore "no transaction is active" — the caller rolls back
            // defensively and SQLite may have unwound already.
            if let Err(e) = sqlx::query("ROLLBACK").execute(conn).await {
                log::debug!("db_tx: ROLLBACK ignored: {e}");
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_tx_execute(
    state: tauri::State<'_, DbTxState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<u64, String> {
    with_conn(&state, move |conn| {
        Box::pin(async move {
            let query = bind_params(sqlx::query(&sql), params);
            let res = query
                .execute(conn)
                .await
                .map_err(|e| format!("db_tx: execute failed: {e}"))?;
            Ok(res.rows_affected())
        })
    })
    .await
}

#[tauri::command]
pub async fn db_tx_select(
    state: tauri::State<'_, DbTxState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    with_conn(&state, move |conn| {
        Box::pin(async move {
            let query = bind_params(sqlx::query(&sql), params);
            let rows = query
                .fetch_all(conn)
                .await
                .map_err(|e| format!("db_tx: select failed: {e}"))?;

            rows.iter().map(row_to_json).collect()
        })
    })
    .await
}
