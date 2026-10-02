# Development

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- Tauri v2 system dependencies ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))

## Setting up on another machine

```bash
git clone https://github.com/seemopz/maish.git
cd maish
npm install
npm run tauri build -- --no-bundle
```

On macOS the system dependency is the Xcode command line tools, and Homebrew's
`rustup` is keg-only — its shims are not linked into `/opt/homebrew/bin`, so the
toolchain stays invisible until the directory is on `PATH`:

```bash
brew install rustup
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$PATH"' >> ~/.zshrc
rustup default stable
```

Everything needed to build is in the repository — `package-lock.json` pins the
frontend dependencies and `src-tauri/Cargo.lock` the Rust ones. The first Rust
build takes several minutes; later ones are far quicker.

Your mail is **not** in the repository, and must not be. Two files hold it, both
named after the application identifier `xyz.hochreiner.maish`. Where they live
depends on the platform: Tauri's config and data directories are two separate
trees on Linux and the same folder on macOS.

| What | Linux | macOS |
|---|---|---|
| Database | `~/.config/xyz.hochreiner.maish/maish.db` | `~/Library/Application Support/xyz.hochreiner.maish/maish.db` |
| Encryption key | Secret Service (KWallet / GNOME Keyring), service `xyz.hochreiner.maish` | Keychain, service `xyz.hochreiner.maish` |
| Log | `~/.local/share/xyz.hochreiner.maish/logs/Maish.log` | `~/Library/Logs/xyz.hochreiner.maish/Maish.log` |

Starting without them gives you an empty client: add the account again and let
it sync. The database alone cannot be read on another machine — every stored
password and token is encrypted with the key, which lives in the OS keychain
(entry `credential-encryption-key` under service `xyz.hochreiner.maish`) and
does not travel with the database. After copying the database, re-enter the
account passwords; do not copy the key around.

The key is created on the first credential the app encrypts, so a fresh
installation has none until an account is added. If it is missing while
encrypted credentials are stored, the app raises an error instead of creating a
new one, because a new key would make them all unreadable.

An installation from before the keychain has the key in `maish.key` in the
data directory. On the first start the app moves it into the keychain, decrypts
a stored credential with it, and only then deletes the file; if that check
fails the file stays and an error names the cause.

Copy the database with SQLite rather than `cp`, so the write-ahead log is
included — the WAL routinely holds several megabytes that the `.db` file does
not:

```bash
# Linux
sqlite3 "file:$HOME/.config/xyz.hochreiner.maish/maish.db?mode=ro" ".backup /path/to/target/maish.db"
```

```bash
# macOS
sqlite3 "file:$HOME/Library/Application Support/xyz.hochreiner.maish/maish.db?mode=ro" ".backup /path/to/target/maish.db"
```

## Commands

```bash
# Start Tauri dev (frontend + backend)
npm run tauri dev

# Vite dev server only (no Tauri)
npm run dev

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/stores/uiStore.test.ts

# Type-check
npx tsc --noEmit

# Build for production
npm run tauri build

# Rust only (from src-tauri/)
cd src-tauri && cargo build
```

## Testing

- **Framework:** Vitest + jsdom
- **Setup:** `src/test/setup.ts` (imports `@testing-library/jest-dom/vitest`)
- **Config:** `globals: true` -- no imports needed for `describe`, `it`, `expect`
- **Location:** Tests are colocated with source files (e.g., `uiStore.test.ts` next to `uiStore.ts`)
- **Count:** reported by `npm run test`. Deliberately not written down here: a number in a document is either stale or a merge conflict, and usually both

### Zustand test pattern

```ts
beforeEach(() => {
  useStore.setState(initialState);
});

it('does something', () => {
  useStore.getState().someAction();
  expect(useStore.getState().value).toBe(expected);
});
```

### Startup races

`main.tsx` renders under `<StrictMode>`, so in a development build (`tauri dev`)
the `init()` effect in `App.tsx` starts twice at the same moment and everything
in it runs concurrently with itself. `runMigrations()` shares one run between
concurrent callers for that reason. A release build starts it once, so a
startup race does not reproduce there.

To reproduce one without the dev server:

```bash
NODE_ENV=development npm run tauri build -- --no-bundle
```

This gives a development React build. To run it beside a live session without
touching real data, add `--config '{"identifier":"xyz.hochreiner.maish.verify"}'`
and start it with a throwaway `HOME`. The identifier matters as well as `HOME`:
the single-instance socket is `/tmp/<identifier>_si.sock` whatever `HOME` says.

## Building

```bash
# Build for your current platform
npm run tauri build
```

Produces native installers:
- **Windows** -- `.msi` / `.exe`
- **macOS** -- `.dmg` / `.app`
- **Linux** -- `.deb` / `.AppImage`

`bundle.createUpdaterArtifacts` is on, so every build also writes an updater
bundle (`.app.tar.gz` on macOS, the `.AppImage` on Linux, the installers on
Windows) next to the installers, and then signs it.

**Bundling now needs the updater signing key.** The bundles are written first and
the signing step runs after them, so without `TAURI_SIGNING_PRIVATE_KEY` the
command fails at the very end with `A public key has been found, but no private
key`. Two ways around it locally:

```bash
# Skip bundling entirely -- what this fork normally uses
npm run tauri build -- --no-bundle

# Bundle, but skip the signature
npm run tauri build -- --no-sign
```

### App icon

The icon sources live in `src-tauri/icons/`:

- `icon.svg` — full-bleed rounded square, for Windows, Linux and the in-app copies
- `icon-macos.svg` — an 824 px body with a 100 px margin on the 1024 px canvas,
  the grid macOS expects. It becomes `icon.icns`, the icon macOS shows before 26
- `Maish.icon` — the Icon Composer icon macOS 26 uses. The background is the
  system fill, so the icon turns white or black with the icon style the user
  picks, and the glyph colour is set per appearance. Its layer is a filled
  outline (`Assets/envelope.svg`): Icon Composer fills every path and ignores
  strokes

Tauri 2.10 cannot compile an `.icon` itself, so the compiled `Assets.car` is
committed in `icons/macos/` and copied into the bundle by `bundle.macOS.files`.
`src-tauri/Info.plist` adds `CFBundleIconName`, which points macOS at it. After
editing `Maish.icon` (Xcode 26 required), from `src-tauri/`:

```bash
xcrun actool icons/Maish.icon --compile /tmp/maish-actool --platform macosx \
  --minimum-deployment-target 10.13 --app-icon Maish \
  --output-partial-info-plist /tmp/maish-actool/partial.plist
cp /tmp/maish-actool/Assets.car icons/macos/Assets.car
```

After editing either SVG, regenerate from `src-tauri/` and keep only
`icon.icns` from the macOS run:

```bash
npx tauri icon icons/icon.svg
npx tauri icon icons/icon-macos.svg -o /tmp/maish-icon-macos
cp /tmp/maish-icon-macos/icon.icns icons/icon.icns
cp icons/icon.png ../src/assets/icon.png
npx tauri icon icons/icon.svg -p 1024 -o /tmp/maish-icon-readme
cp /tmp/maish-icon-readme/1024x1024.png ../assets/icon.png
```

`src/assets/icon.png` is the About panel's copy and `assets/icon.png` the
README's. The splash screen draws the same mark inline in `splashscreen.html`.

## Release Artifacts

Releases are published by merging the release-please pull request. That creates
the tag and the GitHub release; `.github/workflows/build-release.yml` then builds
the app and attaches the bundles, their `.sig` files and a merged `latest.json`.
The updater reads that file from
`releases/latest/download/latest.json` (`plugins.updater.endpoints` in
`src-tauri/tauri.conf.json`).

Tags and release titles are plain `vX.Y.Z` (`include-component-in-tag: false`).
Releases up to 0.4.0 were tagged `maish-vX.Y.Z` and titled `maish: vX.Y.Z`.
release-please no longer recognises those tags as releases of this package, so
`bootstrap-sha` points at the 0.4.0 release commit to stop the changelog there.
It only applies while no `v`-tagged release exists and can be removed after the
first one.

The build covers macOS arm64, Linux x86_64 (built on Ubuntu 22.04, so the
AppImage runs on any distribution with glibc 2.35 or newer) and Windows x86_64.
The three run one after another because tauri-action merges `latest.json` by
downloading, extending and re-uploading it — two jobs finishing together can
drop a platform. A final job, `Verify latest.json`, fails the run unless every
platform is in the file and signed with the key in `plugins.updater.pubkey`
(`.github/scripts/verify-updater-json.mjs`).

Linux ships an AppImage, a `.deb` and an `.rpm`; only the AppImage updates
itself. Windows ships an NSIS `.exe` and an `.msi`; the updater uses the NSIS
installer, which installs per user and needs no admin prompt. The Windows
installers are not code-signed, so SmartScreen asks once before the first run
(**More info → Run anyway**).

The macOS bundle is signed ad hoc (`bundle.macOS.signingIdentity: "-"`), not
with an Apple Developer ID, and it is not notarized. A downloaded copy therefore
opens only after **System Settings → Privacy & Security → Open Anyway**, once per
installation; updates installed by the app itself are not quarantined and open
directly. Without the ad-hoc identity the linker signs only the executable, and
Gatekeeper reports the whole app as "damaged" with no way to open it. The
workflow checks the seal with `codesign --verify --deep --strict`. Removing the
prompt entirely needs a paid Developer ID certificate plus notarization.

Two repository secrets are required:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the minisign private key matching `plugins.updater.pubkey` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password that key was generated with |

**The key must have a password, and the second secret is not optional**, even
though Tauri's own documentation calls it so. On CI the CLI substitutes an empty
string for a missing password rather than treating the key as unencrypted, so a
key generated without one fails the build with `incorrect updater private key
password: Wrong password for that key`. Verified against CLI 2.10.0.

A new key pair is generated with:

```bash
npm run tauri signer generate -- -w ~/.tauri/maish.key -p '<password>'
```

The public half has to be copied into `plugins.updater.pubkey`. Replacing the key
invalidates every update for clients that already shipped with the old public
key, so this is a one-way step.

The key was replaced once, on 2026-09-25 (key ID `AC3546AC3CF479E1`), because
the original private key was lost and the secret held an unusable value — no
release up to 0.4.0 ever got signed artifacts. Installs built before that date
carry the old public key and have to be updated by hand once. The private key and
its password are kept in the maintainer's password manager.

Re-running a build, or filling in a release published before this workflow
existed, is done by dispatching **Build Release Artifacts** manually with the tag
(for example `v0.4.1`, or `maish-v0.4.0` for older releases). Tags older than the `createUpdaterArtifacts` change
produce installers but no `.sig` files and no `latest.json`.

## Email Account Setup

### Gmail (OAuth)

Maish connects directly to Gmail via OAuth. You need your own Google Cloud credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API** and **Google Calendar API**
4. Create OAuth 2.0 credentials (Desktop application)
5. In Maish's Settings, enter your Client ID

> Maish uses PKCE flow -- no client secret is required.

### IMAP/SMTP

For non-Gmail providers (Outlook, Yahoo, iCloud, Fastmail, etc.):

1. Click the account switcher in the sidebar → **Add IMAP Account**
2. Enter your email address and password (or app-password)
3. Maish auto-discovers server settings for well-known providers
4. For other providers, enter IMAP/SMTP host, port, and security manually
5. Test connection, then save

> No Google Cloud project or Client ID needed. Passwords are encrypted with AES-256-GCM in the local database. Some providers (e.g., Gmail, Yahoo) require an app-specific password instead of your main password.

## AI Setup (Optional)

To enable AI features, add your API key for one or more providers in Settings:

- **Anthropic Claude** -- [Get API key](https://console.anthropic.com/) -- Haiku 4.5 (default), Sonnet 4, Opus 4
- **OpenAI** -- [Get API key](https://platform.openai.com/) -- GPT-4o Mini (default), GPT-4o, GPT-4.1 series
- **Google Gemini** -- [Get API key](https://aistudio.google.com/) -- 2.5 Flash (default), 2.5 Pro

After adding an API key, select which model to use for each provider in Settings > AI.
