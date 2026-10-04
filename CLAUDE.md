# Maish

Tauri v2 desktop mail client (Rust backend + React 19 frontend), a fork of Velo
(`avihaymenahem/velo`, Apache-2.0) now maintained independently as
`seemopz/maish`. Identity `Maish` / `xyz.hochreiner.maish`. No upstream remote,
no changes sent upstream.

## Licence obligations (Apache-2.0)

- Keep `LICENSE`, `NOTICE` and the upstream copyright line in the About panel
  (`src/components/settings/SettingsPage.tsx`, section 4(c)).
- Any behavioural change to forked code is a 4(b) modification: record it in `NOTICE`.

## Working rules

- Branch prefixes also include `debug/` for throwaway instrumentation; delete it once the question is answered.
- UI strings and `NOTICE` are English too, including throwaway debug output.
- Push, pull request, issue comment: draft the exact text, show it, wait.
- The release-please PR is read-only: never merge, close or edit it, never tag. Explain it when asked, then wait – merging it publishes a release.
- Bugfixes start with a failing test. When a bug is not understood, instrument the boundaries and read what happens instead of reasoning forward.
- `feat!:` stays a minor bump below 1.0.0 (`bump-minor-pre-major`); 1.0.0 is cut by hand, never by a commit message.
- After adding a feature, run `/document-feature` to add its help card.

## Commands

- Dev: `npm run tauri dev` · Vite only: `npm run dev`
- Release build: `npm run tauri build -- --no-bundle` (~3 min)
- Tests: `npm run test` · single file: `npx vitest run <file>`
- Types: `npx tsc --noEmit` · Rust (in `src-tauri/`): `cargo build`, `cargo test`
- Run the release binary on KDE/Wayland: `DISPLAY=:0 XAUTHORITY=$(ls -t /run/user/1000/xauth_* | head -1) ./src-tauri/target/release/maish`
- Data, key and log paths per OS: `docs/development.md`

## Where to read more

- Architecture, services, UI, styling, testing, database: `docs/codebase.md`
- CalDAV/CardDAV, recurrence, vCard – read before touching `src/services/{calendar,contacts,dav}/`: `docs/dav.md`
- Frontend logging: `console.log` never reaches the log file – call `logToFile(level, message)` (`src/services/logFile.ts`, backed by the `log_frontend` command). Sync failures already go there.

## Fork-specific behaviour

These four are why the fork exists. Each was verified against a self-hosted
Stalwart server.

- **IMAP FETCH data lists are parenthesised** (`src-tauri/src/imap/client.rs`).
  RFC 3501 §6.4.5 requires `(UID FLAGS INTERNALDATE BODY.PEEK[])`; `async-imap`
  forwards the string verbatim. Dovecot tolerates the unparenthesised form,
  Stalwart evaluates only the leading `UID` and answers without `BODY[]` — the
  fetch succeeds and every message arrives empty
- **Transactions run on a dedicated SQLite connection**, not the plugin's pool
  (`src-tauri/src/db_tx.rs`, `src/services/db/connection.ts`). `tauri-plugin-sql`
  calls `Pool::connect()`, so `BEGIN`, the statements and `COMMIT` would each
  land on a different pooled connection — the one holding `BEGIN` keeps the
  write lock while the others block on it. `withTransaction()` uses the
  `db_tx_*` commands, and `getDb()` returns that same connection while a
  transaction is open so the db modules join it. `PRAGMA busy_timeout` does not
  fix this; it turns the immediate error into an indefinite hang. Two caveats:
  `lastInsertId` is always `0` on that connection, and UI reads during a
  transaction see uncommitted state
- **CalDAV runs over `@tauri-apps/plugin-http`**, never the webview
  (`src/services/calendar/davFetch.ts`). DAV servers send no CORS headers, so a
  webview PROPFIND always fails with `Load failed`, whatever `connect-src`
  allows. **Every `DAVClient` must be constructed with `fetch: davFetch`** —
  tsdav resolves its transport once at import time and prefers
  `globalThis.fetch`, so patching the global or aliasing `cross-fetch` does
  nothing. `davFetch` also translates `redirect: "manual"` into
  `maxRedirections: 0`, without which RFC 6764 discovery silently follows the
  `/.well-known/caldav` hop and never sees the 3xx. Two further traps live in
  the same library: it merges a call's parameters over the client's defaults
  one level deep, so a `headers` argument **replaces** the authorization header
  set at login and every write comes back 401 — pass the etag on the calendar
  object and let tsdav build the `If-Match` itself; and its write functions
  return the raw response and throw only on a transport failure, so a status
  has to be checked or a 401 or 412 passes for a successful save
- **CalDAV settings attach to an existing account** (`saveCalDavAccount()` in
  `src/services/db/accounts.ts`). `accounts.email` is UNIQUE and a calendar
  usually belongs to an address that already has a mail account, so inserting a
  second row fails. Discovery additionally probes `accounts.imap_host`, because
  self-hosted setups routinely split mail domain and server host


## Pitfalls

- **Tauri SQL plugin config**: `preload` in tauri.conf.json must be an array `["sqlite:maish.db"]` — NOT an object/map
- **Bundling requires the updater signing key**: `bundle.createUpdaterArtifacts` is `true`, so `npm run tauri build` writes the bundles and then fails at the signing step unless `TAURI_SIGNING_PRIVATE_KEY` is set. Use `--no-bundle` (the normal case here) or `--no-sign`. The key must carry a password: on CI the CLI substitutes an empty string for a missing `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` rather than treating the key as unencrypted, so a password-less key is rejected. See `docs/development.md` → Release Artifacts
- **Renaming the app identity moves three data artifacts, not one**: the database (`~/.config/<identifier>/maish.db`), the AES key and the log directory. Those are the Linux paths; on macOS the database lives in `~/Library/Application Support/<identifier>/`, because Tauri's `AppConfig` and `AppData` resolve to the same folder there. The key is an OS keychain entry (service `xyz.hochreiner.maish`, account `credential-encryption-key`, `src-tauri/src/credential_key.rs`), so a renamed service finds an empty slot: `crypto.ts` then raises an error instead of generating a new key, because encrypted credentials are stored. Copy the keychain entry to the new service name, or re-enter the passwords
- **The database filename lives in three places and they must agree**: `preload` in tauri.conf.json, `Database.load()` in `src/services/db/connection.ts`, and the `db_tx` path in `src-tauri/src/lib.rs` `setup()`. Miss one and the app splits in half — pooled reads and writes hit one file while everything inside a transaction hits another, so the UI reads an empty database while sync fills the other one
- **Tauri Emitter trait**: Must `use tauri::Emitter;` to call `.emit()` on windows
- **Tauri capabilities**: Any new plugin needs explicit permissions added to `src-tauri/capabilities/default.json`. Windows allow `"main"`, `"splashscreen"`, and `"thread-*"` wildcard
- **Single instance**: `tauri-plugin-single-instance` must be first plugin registered. Forwards args for deep linking
- **StrictMode runs the startup effect twice in a development build**: `init()` in `App.tsx` runs concurrently with itself under `tauri dev`, never in a release build. How to reproduce startup races: `docs/development.md` → Startup races
- **Minimize-to-tray**: Use `.on_window_event()` on the Builder, not `window.on_window_event()`
- **IMAP message IDs**: Format is `imap-{accountId}-{folder}-{uid}` — not the RFC Message-ID header
- **IMAP UIDVALIDITY**: If UIDVALIDITY changes on a folder, all cached UIDs are invalid — triggers full resync of that folder
- **Provider abstraction**: All sync/send operations go through `EmailProvider` interface — use `getEmailProvider(account)` from `providerFactory.ts`, never call Gmail or IMAP APIs directly from components
- **Offline mode**: All email modify operations (archive, trash, star, read, send, labels, drafts) go through `emailActions.ts` which applies optimistic UI updates, local DB changes, and queues operations when offline. Never call `getGmailClient()` directly for modify operations — use the convenience wrappers (`archiveThread`, `trashThread`, `starThread`, etc.). Queue processor runs every 30s, compacts redundant ops, uses exponential backoff retries. Conflict detection in delta sync skips threads with pending local ops
- **Archive, trash, spam and move are delayed by 5 s**: `archiveThread`/`trashThread`/`spamThread`/`moveThread` change the UI and local DB at once but hand the server call (or offline-queue entry) to `undoableActions.ts`, which sends it when the undo toast expires — `z` or the button reverts the local state instead. IMAP cannot be undone by an inverse move (a move assigns new UIDs the client never sees), hence the delay. Background callers and archive-after-send pass `{ undo: false }`; a test that expects the provider call right after `await archiveThread(...)` must do the same or call `flushPendingUndo()`
- **Email HTML rendering**: DOMPurify sanitization, rendered in sandboxed iframe (`allow-same-origin` only). Strips remote images by default (uses `data-blocked-src` attributes), allowlist per sender
- **Plain-text bodies are linkified**: a message with no HTML part goes through `linkifyPlainText()` (`src/utils/linkify.ts`), which escapes the body and inserts anchors for http(s), `mailto:`, bare `www.` hosts and bare addresses. Escaping and matching happen in one pass on the raw text — escaping afterwards would show the anchors as text, matching afterwards would let a body containing `&`, `<` or `"` steer the match. The anchors are clicked like any other: the frame reports them over postMessage and `EmailRenderer` re-checks the scheme before handing the URL to the opener
