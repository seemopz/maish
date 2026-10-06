# Codebase guide

Moved out of `CLAUDE.md` to keep the always-loaded file short. Read the section you need.

## Architecture

Tauri v2 desktop app: Rust backend + React 19 frontend communicating via Tauri IPC.

### Three-layer data flow

1. **Rust backend** (`src-tauri/`): System tray, minimize-to-tray (hide on close), splash screen, OAuth localhost server (port 17248, PKCE), single-instance enforcement, autostart support, IMAP/SMTP client modules. Tauri commands: `start_oauth_server`, `close_splashscreen`, `set_tray_tooltip`, `open_devtools`, 5 transaction commands (`db_tx_begin`, `db_tx_execute`, `db_tx_select`, `db_tx_commit`, `db_tx_rollback`, see Fork-specific behaviour), plus 11 IMAP commands (`imap_test_connection`, `imap_list_folders`, `imap_fetch_messages`, `imap_fetch_new_uids`, `imap_fetch_message_body`, `imap_set_flags`, `imap_move_messages`, `imap_delete_messages`, `imap_get_folder_status`, `imap_fetch_attachment`, `imap_append_message`) and 2 SMTP commands (`smtp_send_email`, `smtp_test_connection`). Rust IMAP uses `async-imap` + `mail-parser`, SMTP uses `lettre`. IMAP commands share a per-account session pool (`src-tauri/src/imap/pool.rs`, Tauri state): at most 2 idle sessions per account, `NOOP` probe after 20 s idle, dropped after 5 min or after any error, no automatic retry (`move`/`delete`/`append` are not idempotent). `imap_test_connection` and the raw-TCP fetch fallback bypass it. Plugins: sql (SQLite), notification, opener, log, dialog, fs, http, single-instance, autostart, deep-link (`mailto:` scheme), global-shortcut. Windows-specific: sets AUMID for proper notification identity.

2. **Service layer** (`src/services/`): All business logic. Plain async functions (not classes, except `GmailClient`).
   - `db/` — SQLite queries via `getDb()` singleton from `connection.ts`. Version-tracked migrations in `migrations.ts`. FTS5 full-text search on messages (trigram tokenizer). One file per area: accounts, messages, threads, labels, contacts, filters, templates, signatures, attachments, scheduled emails, image allowlist, search, settings, AI cache, bundle rules, calendar events, follow-up reminders, notification VIPs, thread categories, send-as aliases, smart folders, quick steps, link scan results, phishing allowlist, folder sync state, and smart label rules.
   - `email/` — `EmailProvider` abstraction unifying Gmail API and IMAP/SMTP behind a single interface. `providerFactory.ts` returns appropriate provider based on `account.provider` field ("gmail_api" or "imap"). `gmailProvider.ts` wraps existing GmailClient. `imapSmtpProvider.ts` delegates to Rust IMAP/SMTP Tauri commands.
   - `gmail/` — `GmailClient` class auto-refreshes tokens 5min before expiry, retries on 401. `tokenManager.ts` caches clients per account in a Map. `syncManager.ts` orchestrates sync (60s interval) for both Gmail and IMAP accounts via the EmailProvider abstraction. `sync.ts` does initial sync (365 days, configurable via `sync_period_days` setting) and delta sync via Gmail History API; falls back to full sync if history expired (~30 days). `authParser.ts` parses SPF/DKIM/DMARC from `Authentication-Results` headers. `sendAs.ts` fetches send-as aliases from Gmail API.
   - `imap/` — IMAP-specific services. `tauriCommands.ts` wraps Rust IMAP Tauri commands. `imapSync.ts` orchestrates IMAP initial sync (batch fetch, 50 messages/batch) and delta sync via UIDVALIDITY/last_uid tracking. `folderMapper.ts` maps IMAP folders (special-use flags + well-known names) to Gmail-style labels. `autoDiscovery.ts` provides pre-configured server settings for 7 major providers (Outlook, Yahoo, iCloud, AOL, Zoho, FastMail, GMX). `imapConfigBuilder.ts` builds IMAP/SMTP configs from account records. `messageHelper.ts` handles IMAP message utilities.
   - `contacts/` — CardDAV address books. `carddavProvider.ts` talks to tsdav with `fetch: davFetch` and `defaultAccountType: "carddav"`; `vcardHelper.ts` reads and writes vCard 3.0/4.0; `vcardEdit.ts` patches a stored card in place; `contactSync.ts` stores what a run fetched and folds mail-derived rows into the card that claims their address; `contactActions.ts` is the write path from the UI; `autoDiscovery.ts` and `providerFactory.ts` mirror their calendar counterparts. See Contacts have two origins under Key Gotchas.
   - `dav/` — `contentLine.ts`, the line format iCalendar and vCard share: unfolding, parameter quoting, text escaping, folding.
   - `threading/` — JWZ threading algorithm (`threadBuilder.ts`) for grouping IMAP messages into conversation threads using Message-ID, References, and In-Reply-To headers. Supports incremental threading, phantom containers for missing references, and subject-based merging.
   - `ai/` — `aiService.ts` provides thread summaries, smart replies, AI compose, text transform, auto-categorization, smart label classification, and task extraction. `providerManager.ts` manages three providers (`providers/claudeProvider.ts`, `providers/openaiProvider.ts`, `providers/geminiProvider.ts`). `askInbox.ts` enables natural language inbox queries. `categorizationManager.ts` auto-sorts threads into Primary/Updates/Promotions/Social/Newsletters. `writingStyleService.ts` analyzes user writing style from sent emails and generates auto-draft replies. `taskExtraction.ts` extracts tasks from email threads via AI. `errors.ts` and `types.ts` define shared AI types. Results cached locally via `db/aiCache.ts`.
   - `calendar/` — `CalendarProvider` abstraction over Google Calendar and CalDAV, selected by `providerFactory.ts`. `caldavProvider.ts` talks to tsdav, always with `fetch: davFetch`. `icalHelper.ts` parses iCalendar into a component tree and builds VEVENTs; `icalEdit.ts` patches a stored calendar object in place; `recurrence.ts` expands RRULE/RDATE/EXDATE into instances; `recurrenceForm.ts` translates between an RRULE and the handful of rules the repeat control can state; `timezone.ts` converts between wall-clock time in an IANA zone and epoch seconds via `Intl`; `occurrences.ts` bridges stored rows and the instances a view renders. See Recurring events under Key Gotchas.
   - `composer/` — `draftAutoSave.ts` auto-saves drafts every 3 seconds (debounced). Watches composer state changes via Zustand subscribe.
   - `search/` — `searchParser.ts` parses Gmail-style operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread/read/starred`, `before:`, `after:`, `label:`). `searchQueryBuilder.ts` builds SQL queries from parsed operators.
   - `filters/` — `filterEngine.ts` auto-applies filters to incoming messages during sync. Criteria use AND logic (case-insensitive substring matching). Actions: applyLabel, archive, trash, star, markRead.
   - `categorization/` — `ruleEngine.ts` applies rule-based categorization (pattern matching on sender/subject) before falling back to AI.
   - `snooze/` — Background interval checkers for snooze unsnooze and scheduled sends.
   - `followup/` — `followupManager.ts` checks for follow-up reminders (threads with no reply after user-set delay).
   - `bundles/` — `bundleManager.ts` manages newsletter bundling with delivery schedules.
   - `notifications/` — `notificationManager.ts` provides OS notifications via tauri-plugin-notification with VIP sender filtering.
   - `contacts/` — `gravatar.ts` fetches Gravatar profile images for contacts.
   - `attachments/` — `cacheManager.ts` handles local attachment caching with size limits. `preCacheManager.ts` background pre-caches recent small attachments (<5MB, 7 days) every 15 minutes.
   - `unsubscribe/` — `unsubscribeManager.ts` handles one-click unsubscribe (RFC 8058 List-Unsubscribe-Post and mailto: fallback).
   - `quickSteps/` — Custom action chain executor with 18 action types. `executor.ts` runs action sequences on threads. `defaults.ts` provides preset templates. `types.ts` defines action chain schema.
   - `queue/` — `queueProcessor.ts` processes offline operation queue every 30s. Compacts redundant ops, retries with exponential backoff (60s→300s→900s→3600s), marks permanently failed ops.
   - `tasks/` — `taskManager.ts` handles recurring task logic: `parseRecurrenceRule`, `calculateNextOccurrence` (daily/weekly/monthly/yearly), `handleRecurringTaskCompletion` (completes current, creates next).
   - `smartLabels/` — AI-powered auto-labeling. `smartLabelService.ts` two-phase matching (criteria fast path + AI classification). `smartLabelManager.ts` sync integration orchestrator. `backfillService.ts` batch-applies to existing inbox emails.
   - Root-level services: `emailActions.ts` (centralized offline-aware email action service — optimistic UI, local DB updates, offline queueing), `badgeManager.ts` (taskbar badge count), `deepLinkHandler.ts` (`mailto:` protocol handling), `globalShortcut.ts` (system-wide compose shortcut).

3. **UI layer** (`src/components/`, `src/stores/`): Zustand stores (`uiStore`, `accountStore`, `threadStore`, `composerStore`, `labelStore`, `contextMenuStore`, `shortcutStore`, `smartFolderStore`, `taskStore`) — simple synchronous state, no middleware. Components subscribe directly via hooks.

### Component organization

Component groups:
- `layout/` — Sidebar, EmailList, ReadingPane, TitleBar
- `email/` — ThreadView, ThreadCard (two-finger trackpad and one-finger touch swipe via `hooks/useSwipeGesture.ts`; actions in `utils/swipeActions.ts` and `services/swipeActions.ts`, settings `swipe_left_actions` / `swipe_right_actions`, an ordered list per side), MessageItem, EmailRenderer (relays the body frame's `maish:wheel` reports as wheel events on the iframe), ActionBar, AttachmentList, SnoozeDialog, ContactSidebar, FollowUpDialog, InlineAttachmentPreview, InlineReply, SmartReplySuggestions, ThreadSummary, SyncNowButton, AuthBadge, AuthWarningBanner, PhishingBanner, LinkConfirmDialog, CategoryTabs, MoveToFolderDialog
- `composer/` — Composer (TipTap v3 rich text editor), AddressInput, EditorToolbar, AttachmentPicker, ScheduleSendDialog, SignatureSelector, TemplatePicker, UndoSendToast, AiAssistPanel, FromSelector
- `search/` — CommandPalette, SearchBar, ShortcutsHelp, AskInbox
- `settings/` — SettingsPage, FilterEditor, LabelEditor, SignatureEditor, TemplateEditor, ContactEditor, SubscriptionManager, QuickStepEditor, SmartFolderEditor, CalDavSettings, CardDavSettings
- `accounts/` — AddAccount, AddImapAccount, AddCalDavAccount, AddCardDavAccount, AccountSwitcher, SetupClientId
- `calendar/` — CalendarPage, CalendarList, CalendarReauthBanner, CalendarToolbar, DayView, WeekView, MonthView, EventCard, EventCreateModal, EventDetailModal, RecurrenceField
- `contacts/` — ContactsPage, ContactDetail
- `attachments/` — AttachmentLibrary, AttachmentGridItem, AttachmentListItem
- `tasks/` — TasksPage, TaskItem, TaskQuickAdd, TaskSidebar, AiTaskExtractDialog
- `help/` — HelpPage, HelpSidebar, HelpSearchBar, HelpCard, HelpCardGrid
- `labels/` — LabelForm
- `dnd/` — DndProvider (@dnd-kit drag-and-drop: threads → sidebar labels)
- `ui/` — UndoActionToast (undo toast for archive / trash / spam / move; logic in `services/undoableActions.ts`, which holds the server call back for 5 s), EmptyState, Skeleton, ContextMenu, ContextMenuPortal, OfflineBanner, SyncIndicator (sync spinner / error icon in the sidebar's bottom bar, state in `uiStore.syncState`), illustrations/ (InboxClearIllustration, NoAccountIllustration, NoSearchResultsIllustration, ReadingPaneIllustration, GenericEmptyIllustration)

### Multi-window support

Thread pop-out windows via `ThreadWindow.tsx`. Entry point in `main.tsx` checks URL params (`?thread=...&account=...`) to render `<ThreadWindow />` or `<App />`. Window label format: `thread-{threadId}`. Tauri capabilities allow `thread-*` wildcard. Default size: 800x700. Splash screen window (400x300, no decorations, always on top) shown during initialization.

### Startup sequence (App.tsx)

1. `runMigrations()`
2. Restore persisted settings: theme, color theme, sidebar, contact sidebar, reading pane position, read filter, email list width, email density, default reply mode, mark-as-read behavior, send & archive, font scale, inbox view mode, phishing detection, sidebar nav config
3. Load custom keyboard shortcuts (`shortcutStore.loadKeyMap()`)
4. `getAllAccounts()` → `initializeClients()` (Gmail API clients) / create IMAP providers → `fetchSendAsAliases()` per Gmail account
5. `startBackgroundSync()` (60s interval), `backfillUncategorizedThreads()`
6. `startSnoozeChecker()` + `startScheduledSendChecker()` + `startFollowUpChecker()` + `startBundleChecker()` (60s intervals) + `startQueueProcessor()` (30s) + `startPreCacheManager()` (15min)
7. Initialize network status detection (`online`/`offline` window events → `uiStore.setOnline()`, triggers queue flush on reconnect)
8. `initNotifications()` (request OS permission)
9. `initGlobalShortcut()` (system-wide compose shortcut)
10. `initDeepLinkHandler()` (`mailto:` protocol)
11. `updateBadgeCount()` (taskbar badge)
12. `close_splashscreen` → show main window
13. Cleanup on unmount: stop all background checkers (including queue processor, pre-cache manager), unregister shortcuts, deep link handler

### Cross-component communication

Custom window events: `velo-sync-done`, `velo-toggle-command-palette`, `velo-toggle-shortcuts-help`, `velo-toggle-ask-inbox`, `velo-move-to-folder`. Tray emits `tray-check-mail` via Tauri event system. `single-instance-args` event for deep link forwarding.

### Keyboard shortcuts

`useKeyboardShortcuts` hook in App.tsx — Superhuman-style keys. Skips when input/textarea/contentEditable is focused. Supports two-key sequences (only `g` prefix currently) with 1s timeout via refs. Shortcut definitions in `src/constants/shortcuts.ts`. Customizable via `shortcutStore` (persisted to SQLite settings).

Key table: `docs/keyboard-shortcuts.md`.



## Styling

Tailwind CSS v4 — uses `@import "tailwindcss"`, `@theme {}` for custom properties, and `@custom-variant dark` in `src/styles/globals.css`. Dark mode toggles via `<html class="dark">` which swaps CSS custom properties. Font scaling via `font-scale-{small|default|large|xlarge}` classes on `<html>`; `reduce-motion` on `<html>` switches off every animation and transition.

The look is a monochrome design after Vercel's Geist system: Geist Sans for reading, Geist Mono for metadata (bundled via `@fontsource-variable/geist` and `geist-mono`), hairline borders instead of shadows, 6px radii (`--radius-lg` is overridden to 6px too). Surfaces separate by tonal value — `bg-bg-secondary` for canvas, sidebar and toolbars, `bg-bg-primary` for content — never by blur or gradients.

**Semantic color tokens**: `bg-bg-primary/secondary/tertiary/hover/selected`, `text-text-primary/secondary/tertiary`, `border-border-primary/secondary`, `bg-accent/accent-hover/accent-light`, `text-on-accent`, `bg-danger/warning/success`, `bg-sidebar-bg`, `text-sidebar-text`. The accent is monochrome — near-black in light mode, near-white in dark mode — so text on `bg-accent` must use `text-on-accent`, never `text-white`. Status colors are for state only. Tailwind palette colors (`red-500`, …) are not used in components.

**Utilities**: `label-mono` (11px uppercase Geist Mono stamp for section headers and eyebrows), `tracking-display`, `.surface-overlay` + `.overlay-backdrop` for modals and floating panels. Inline metadata (dates, counts, sizes) uses `font-mono text-xs tabular-nums text-text-tertiary`.

**Icons**: `lucide-react` icon library.

## Testing

Vitest + jsdom. Setup file: `src/test/setup.ts` (imports `@testing-library/jest-dom/vitest`). Config: `globals: true` (no imports needed for `describe`, `it`, `expect`). Tests are colocated with source files (e.g., `uiStore.test.ts` next to `uiStore.ts`). Zustand test pattern: `useStore.setState()` in beforeEach, assert via `.getState()`.

Tests sit next to the file they cover, across stores, services, utils, components, constants, the router, hooks and config. `npm run test` reports how many there are; a tally written down here would be a merge conflict on every branch that adds one.

## Database

SQLite via Tauri SQL plugin. Migrations are version-tracked in the `_migrations` table and run transactionally; `MIGRATIONS` in `src/services/db/migrations.ts` is the list, and writing its length down here would be a merge conflict on every branch that adds one. Custom `splitStatements()` handles BEGIN...END blocks in triggers.

Data lives in `~/.config/xyz.hochreiner.maish/maish.db` (WAL), logs in `~/.local/share/xyz.hochreiner.maish/logs/Maish.log`. On macOS the database sits in `~/Library/Application Support/xyz.hochreiner.maish/` and the log in `~/Library/Logs/xyz.hochreiner.maish/Maish.log` — see `docs/development.md` for the full table. The frontend has no log forwarding, so `console.log` never reaches that file — to trace frontend behaviour, add a temporary `#[tauri::command]` that calls `log::warn!` (app-level commands need no capability entry) rather than guessing.

Key tables: `accounts` (with `provider` "gmail_api"|"imap", IMAP/SMTP host/port/security fields, `auth_method`, encrypted `imap_password`, optional `imap_username`), `messages` (with FTS5 index `messages_fts`, `auth_results`, `message_id_header`, `references_header`, `in_reply_to_header`, `imap_uid`, `imap_folder`), `threads` (with `is_pinned`, `is_muted`), `thread_labels`, `labels` (with `imap_folder_path`, `imap_special_use`), `contacts` (frequency-ranked for autocomplete, with `first_contacted_at`; `source` tells a mail-derived row from a synced vCard, which also carries `address_book_id`, `dav_uid`, `dav_href`, `dav_etag`, `vcard_data`, `dav_emails`), `address_books` (CardDAV collections, with `ctag`/`sync_token`/`is_read_only`), `attachments` (with `cached_at`, `cache_size`, `imap_part_id`), `filter_rules` (criteria/actions as JSON), `scheduled_emails` (status: pending/sent/failed), `templates` (with optional keyboard shortcut), `signatures`, `image_allowlist`, `settings` (key-value store), `ai_cache`, `thread_categories`, `calendar_events` (with `rrule` and `recurrence_end` for series masters), `follow_up_reminders`, `notification_vips`, `unsubscribe_actions`, `bundle_rules`, `bundled_threads`, `send_as_aliases`, `smart_folders`, `link_scan_results`, `phishing_allowlist`, `quick_steps`, `folder_sync_state` (IMAP UIDVALIDITY/last_uid/modseq tracking per folder), `pending_operations` (offline action queue with retry/backoff), `writing_style_profiles` (AI writing style per account), `tasks` (full task management with priorities, subtasks, recurrence), `task_tags` (custom task tag colors), `smart_label_rules` (AI auto-labeling rules with optional criteria), `_migrations`.

## Feature notes

- **Tauri window config**: Custom titlebar — macOS uses `titleBarStyle: "Overlay"`, Windows/Linux removes decorations programmatically in Rust setup. 1200x800 default, 800x600 minimum. Splash screen: 400x300, no decorations, center, always on top
- **Windows WebView2**: `Chrome_WidgetWin_0` error on close is benign — ignore it
- **Windows AUMID**: Set explicitly in Rust for proper notification identity (`xyz.hochreiner.maish`)
- **OAuth (Gmail)**: Localhost server tries ports 17248-17251. PKCE flow, no client secret. Client ID stored in SQLite settings table, configured by user in Settings
- **IMAP security mapping**: UI shows "SSL/TLS", "STARTTLS", "None" but config stores "ssl", "starttls", "none"
- **IMAP folders vs labels**: IMAP has no native labels; folders are mapped to Gmail-style labels via `folderMapper.ts` using special-use flags and well-known name matching
- **IMAP passwords**: Encrypted with AES-256-GCM in SQLite (same crypto as OAuth tokens)
- **IMAP username**: Optional `imap_username` column on accounts — when set, used as login username for IMAP/SMTP instead of email. Falls back to email when null
- **IMAP auto-discovery**: Pre-configured for Outlook/Hotmail, Yahoo, iCloud, AOL, Zoho, FastMail, GMX; other providers require manual server entry
- **Network detection**: `uiStore.isOnline` tracks connectivity via `navigator.onLine` + window `online`/`offline` events. Queue flush triggers automatically on reconnect
- **CSP**: Allows connections to googleapis.com, anthropic.com, openai.com, generativelanguage.googleapis.com, gravatar.com, googleusercontent.com
- **TypeScript strict mode**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are all enabled. Target ES2021, bundler module resolution, `moduleDetection: "force"`
- **Path alias**: `@/*` maps to `src/*`
- **Thread deletion**: Two-stage — first trash, then permanent delete from DB if already in trash
- **Snooze**: Removes INBOX label and adds SNOOZED label (not just a flag)
- **Draft auto-save**: 3-second debounce, not configurable
- **Gmail History API**: Expires after ~30 days, triggers automatic full sync fallback
- **Vite HMR**: Uses port 1421 when `TAURI_DEV_HOST` is set
- **Vite build**: Multi-page — `index.html` (main app) + `splashscreen.html`
- **Filter engine**: AND logic for criteria, merges actions when multiple filters match same message
- **AI providers**: API keys stored in SQLite settings table. Provider selected per-feature in settings. Results cached in `ai_cache` table
- **Deep links**: `mailto:` scheme registered via tauri-plugin-deep-link. Opens compose window with pre-filled recipient
- **Autostart**: Uses `--hidden` flag to start minimized to tray
- **Phishing detection**: 10 heuristic rules (IP URLs, homograph, suspicious TLDs, URL shorteners, display/href mismatch, suspicious paths, brand impersonation, dangerous protocols, free email impostor, subdomain spoofing). Sensitivity configurable (low/default/high). Results cached in `link_scan_results`. Wired in two places: `MessageItem` calls `scanMessageLinks()` when a message expands and renders `PhishingBanner` above the body, and passes the risky links to `EmailRenderer`, which shows `LinkConfirmDialog` before handing a flagged URL to `openUrl()`. "Trust this sender" writes to `phishing_allowlist`, which suppresses both. The cache stores link scores only — the sensitivity thresholds are applied on read (`applySensitivity()`), so changing the setting also affects messages scanned earlier
- **Auth display**: SPF/DKIM/DMARC parsed from `Authentication-Results` header. Aggregate verdict: pass/fail/warning/unknown. Stored in `messages.auth_results` column
- **Mute threads**: Sets `is_muted` flag, auto-archives. Muted threads suppressed from notifications during delta sync
- **Send-as aliases**: Fetched from Gmail `/settings/sendAs` API on account init (Gmail only). `FromSelector` shown in composer when account has multiple aliases
- **Smart folders**: Saved search queries with dynamic tokens (`__LAST_7_DAYS__`, `__LAST_30_DAYS__`, `__TODAY__`). Managed via `smartFolderStore`
- **Quick steps**: Custom action chains with 18 action types. Executor in `services/quickSteps/executor.ts`
- **Split inbox**: Category tabs (Primary/Updates/Promotions/Social/Newsletters) with backfill service for existing threads
