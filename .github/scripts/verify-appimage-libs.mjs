// Checks that an AppImage does not bundle libraries that have to come from the
// host. The Linux build runs on Ubuntu 22.04 and linuxdeploy copies its
// libwayland-* into usr/lib. WebKitGTK then loads the host's Mesa libEGL against
// that old libwayland-client, and on a current Mesa (Arch, 2026: Mesa 26.2,
// wayland 1.26) the web process aborts at start with
//   Could not create surfaceless EGL display: EGL_BAD_ALLOC. Aborting...
// leaving an empty window. WEBKIT_DISABLE_DMABUF_RENDERER and
// WEBKIT_DISABLE_COMPOSITING_MODE do not help; only the host's libwayland does.
// The release build excludes them via LINUXDEPLOY_EXCLUDED_LIBRARIES.
//
// Usage: node verify-appimage-libs.mjs <Maish.AppImage>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** Libraries that must come from the host, matched against the file name. */
const HOST_ONLY = [/^libwayland-[a-z]+\.so(\.|$)/];

/** Paths in `files` whose file name is a host-only library, in input order. */
export function bundledHostLibs(files) {
  return files.filter((path) => {
    const name = path.split("/").pop() ?? "";
    return HOST_ONLY.some((re) => re.test(name));
  });
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => join(e.parentPath, e.name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const appImage = process.argv[2];
  const work = mkdtempSync(join(tmpdir(), "appimage-"));
  try {
    // An AppImage unpacks itself into ./squashfs-root of the working directory.
    execFileSync(appImage, ["--appimage-extract"], { cwd: work, stdio: "ignore" });
    const root = join(work, "squashfs-root");
    const files = listFiles(root).map((f) => relative(root, f));
    const found = bundledHostLibs(files);
    if (found.length > 0) {
      for (const f of found) console.error(`::error::${appImage} bundles ${f}, which must come from the host`);
      process.exit(1);
    }
    console.log(`${appImage}: no host-only libraries bundled (${files.length} files checked)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
