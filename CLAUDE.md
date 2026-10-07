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
- **Archive, trash, spam and move are delayed by 5 s**: `archiveThread`/`trashThread`/`spamThread`/`moveThread` change the UI and local DB at once, store the call in `pending_operations` with `next_retry_at` `UNDO_HOLD_SEC` (120 s) ahead, and let `undoableActions.ts` claim and send it when the undo toast expires (a quit or crash inside the window leaves the row for the queue processor). `z` or the button deletes the row if it is still unclaimed and restores the thread's labels; the processor and the commit claim rows with `claimOperation()` so only one of them sends. IMAP cannot be undone by an inverse move (a move assigns new UIDs the client never sees), hence the delay. Multi-select loops wrap in `undoBatch()` so they stay one undo step. Background callers, mute and archive-after-send pass `{ undo: false }`; a test that expects the provider call right after `await archiveThread(...)` must do the same or call `flushPendingUndo()`
- **Swipe on thread cards is a `wheel` gesture, in two stages**: a trackpad two-finger swipe arrives as `deltaX` (fingers left = positive), there is no "fingers lifted" event. `useSwipeGesture` ends a swipe after 400 ms of silence (resting fingers send nothing either, so a shorter hold settled the card under a still-held swipe; the body frame's `GESTURE_IDLE_MS` matches it, and a vertical event after a pause longer than 150 ms settles the swipe and scrolls instead of being swallowed) or as soon as six strictly shrinking deltas fall to a third of the peak (macOS momentum), and ignores the rest of the tail on **every** element until the wheel has been quiet for 150 ms — a module-wide flag, because a committed card is removed and the next one slides under the pointer with a fresh hook that would read the tail as a new swipe (and delete it too). On a card (`revealLeftPx`/`revealRightPx` set, 64 px per button) a release past 56 px opens the side's buttons via `onReveal` and runs nothing; only a full swipe (`commitThreshold`: half the width, at most 220 px, always 48 px beyond the open buttons) runs the first button. The reading pane passes no reveal widths and keeps the one-stage swipe (25 % of the width, at most 120 px). Which card is open lives in `uiStore.openSwipe` (one at a time); `ThreadCard` closes it on a tap, a click elsewhere, any scroll (capture) and Escape, and a swipe that starts on an open card begins at its rest offset. Each side has an ordered list of 1–3 actions (`swipe_left_actions`/`swipe_right_actions`, JSON; the old single `swipe_*_action` is read once and becomes the first entry). A gesture that starts vertical is never taken over. It does not touch dnd-kit (pointer events), but is off during a drag, a multi-selection, in drafts, and "delete" is left out of the buttons inside trash (the next one becomes the full-swipe default). A swipe back past the rest position of an open card closes it even when the other side has no buttons (`startedOpen`); the momentum tail of a swipe that ended on momentum is `isSwipeTail()`, and the card ignores `scroll` while it lasts, otherwise the list nudge of the tail closes the card it just opened. From an open card the full swipe lies 96 px beyond the buttons instead of 48. After a release the card and its button field stay mounted for `SWIPE_SETTLE_MS` (300 ms) and ease to rest with a no-overshoot curve; the field remembers its side because `offset` is already 0. Snooze needs a time, so the card opens `SnoozeDialog` instead of calling `runSwipeAction`
- **Swipe in the reading pane turns to the next/previous mail**: `ReadingPane` runs `useSwipeGesture` on the whole pane (left = next, right = previous, the neighbours `j`/`k` use). Wheel events inside the sandboxed body frame never reach the app, so `public/emailFrame.js` reports them as `maish:wheel` and `EmailRenderer` replays them as a `WheelEvent` on the iframe. The frame hands a gesture to content that can still scroll sideways (`pre`, wide tables) from its first event to its last. Like `j`/`k` it does nothing while an input or editor has focus (an unsent inline reply would be lost). The pop-out `ThreadWindow` has no list and no router, so it has no swipe
- **Mouse side buttons and mail zoom**: `useMouseNavigation` (mounted in `App.tsx`) reads `mouseup` of button 3/4 — with a mail open from the list it steps to the previous/next one (like swipe right/left, `k`/`j`), otherwise it calls `router.history.back()`/`forward()`; it does nothing while a field has focus. `useMailZoom` (in `ReadingPane`) turns ctrl+wheel (a pinch arrives that way) and Ctrl/Cmd `+`/`-`/`0` into `uiStore.mailZoom` (0.5–3, saved as `mail_zoom`, debounced). Those key combinations are reserved (`mailZoomKey()` in `src/utils/mailZoom.ts`): `useKeyboardShortcuts` skips them and the shortcut editor refuses to record them, so a custom binding can never fire together with the zoom. The body frame cannot see the store: `EmailRenderer` posts `maish:zoom` to it on load and on change, the frame sets `body.style.zoom` (the body, not the root, so `scrollHeight` stays in viewport px), and it reports ctrl+wheel, button 3/4 and the zoom keys (Ctrl/Cmd `+`/`-`/`0`, so they work with the focus inside the body) as `maish:wheel` (`ctrlKey`), `maish:mouse` and `maish:key`, which the renderer replays on the iframe (a `maish:key` is replayed only if `mailZoomKey()` accepts it). Untested on real hardware: whether WKWebView/WebKitGTK deliver a trackpad pinch as ctrl+wheel and button 3/4 as `mouse*` events. The pop-out `ThreadWindow` restores the saved zoom on open but has no zoom controls of its own
- **Email HTML rendering**: DOMPurify sanitization, rendered in sandboxed iframe (`allow-same-origin` only). Strips remote images by default (uses `data-blocked-src` attributes), allowlist per sender
- **Plain-text bodies are linkified**: a message with no HTML part goes through `linkifyPlainText()` (`src/utils/linkify.ts`), which escapes the body and inserts anchors for http(s), `mailto:`, bare `www.` hosts and bare addresses. Escaping and matching happen in one pass on the raw text — escaping afterwards would show the anchors as text, matching afterwards would let a body containing `&`, `<` or `"` steer the match. The anchors are clicked like any other: the frame reports them over postMessage and `EmailRenderer` re-checks the scheme before handing the URL to the opener
