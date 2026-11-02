// Builds a release's latest.json once, after all platform builds have
// uploaded their bundles and .sig files. The builds run in parallel with
// tauri-action's uploadUpdaterJson off; letting each of them merge its own
// platform into latest.json would race (download, add, upload again).
//
// Follows tauri-action v1 (src/upload-version-json.ts) so clients see the same
// file as before: per OS a primary `{os}-{arch}` entry (AppImage on Linux,
// the NSIS installer on Windows) plus one `{os}-{arch}-{bundle}` entry per
// signed bundle, each URL being the asset's API URL.
//
// Usage: node build-updater-json.mjs <assets.json> <sig dir> <version> <notes file>
//   assets.json: the release's assets as [{ name, url }] (GitHub API fields)
//   sig dir:     every *.sig asset of the release, downloaded under its name
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bundle name patterns as the Tauri CLI writes them. `priority` picks the
// primary `{os}-{arch}` entry, the highest wins.
const BUNDLES = [
  { re: /_(?<arch>[^_]+)\.app\.tar\.gz$/, os: "darwin", bundle: "app", priority: 0 },
  { re: /_(?<arch>[^_]+)\.AppImage$/, os: "linux", bundle: "appimage", priority: 100 },
  { re: /_(?<arch>[^_]+)\.deb$/, os: "linux", bundle: "deb", priority: 0 },
  { re: /\.(?<arch>[^.]+)\.rpm$/, os: "linux", bundle: "rpm", priority: 0 },
  { re: /_(?<arch>[^_]+)-setup\.exe$/, os: "windows", bundle: "nsis", priority: 100 },
  { re: /_(?<arch>[^_]+)_[^_]+\.msi$/, os: "windows", bundle: "msi", priority: 99 },
];

const ARCH = { amd64: "x86_64", x64: "x86_64", x86_64: "x86_64", arm64: "aarch64", aarch64: "aarch64" };

/** latest.json content for the given release assets and .sig contents. */
export function buildUpdaterJson({ version, notes, pubDate, assets, signatures }) {
  const urls = new Map(assets.map((a) => [a.name, a.url]));
  const entries = [];
  for (const { name } of assets) {
    if (!name.endsWith(".sig")) continue;
    const bundleName = name.slice(0, -".sig".length);
    const kind = BUNDLES.find((b) => b.re.test(bundleName));
    const arch = kind && ARCH[bundleName.match(kind.re).groups.arch];
    if (!kind || !arch) throw new Error(`${name}: no updater platform for this bundle`);
    const url = urls.get(bundleName);
    if (!url) {
      console.warn(`${name}: bundle ${bundleName} is not attached, skipped`);
      continue;
    }
    const signature = signatures[name];
    if (signature === undefined) throw new Error(`${name}: signature content missing`);
    entries.push({ key: `${kind.os}-${arch}`, bundle: kind.bundle, priority: kind.priority, entry: { signature, url } });
  }

  const platforms = {};
  const primary = new Map();
  for (const e of entries) {
    platforms[`${e.key}-${e.bundle}`] = e.entry;
    if (!primary.has(e.key) || e.priority > primary.get(e.key).priority) primary.set(e.key, e);
  }
  for (const [key, e] of primary) platforms[key] = e.entry;

  return { version, notes, pub_date: pubDate, platforms };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [assetsPath, sigDir, version, notesPath] = process.argv.slice(2);
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  const signatures = Object.fromEntries(
    readdirSync(sigDir)
      .filter((f) => f.endsWith(".sig"))
      .map((f) => [f, readFileSync(join(sigDir, f), "utf8")]),
  );
  const latest = buildUpdaterJson({
    version,
    notes: readFileSync(notesPath, "utf8"),
    pubDate: new Date().toISOString(),
    assets,
    signatures,
  });
  process.stdout.write(JSON.stringify(latest, null, 2));
}
