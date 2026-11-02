// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledHostLibs } from "./verify-appimage-libs.mjs";

// Lays out ~/.cache/tauri the way the release workflow does, with a fake
// upstream plugin that deploys what linuxdeploy put into 0.11.0's usr/lib.
let cache;
let appdir;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "gtk-plugin-"));
  cache = join(root, "cache");
  appdir = join(root, "Maish.AppDir");
  mkdirSync(join(cache, "upstream"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "linuxdeploy-plugin-gtk.sh"), join(cache, "linuxdeploy-plugin-gtk.sh"));
  const upstream = join(cache, "upstream", "linuxdeploy-plugin-gtk.sh");
  writeFileSync(
    upstream,
    `#! /usr/bin/env bash
[ "$1" = --plugin-api-version ] && { echo 0; exit 0; }
mkdir -p "$2/usr/lib"
for f in libwayland-client.so.0 libwayland-cursor.so.0 libwayland-egl.so.1 libwayland-server.so.0 libepoxy.so.0 im-wayland.so; do
  touch "$2/usr/lib/$f"
done
`,
  );
  chmodSync(upstream, 0o755);
  chmodSync(join(cache, "linuxdeploy-plugin-gtk.sh"), 0o755);
});

afterEach(() => rmSync(join(cache, ".."), { recursive: true, force: true }));

const run = (...args) => execFileSync(join(cache, "linuxdeploy-plugin-gtk.sh"), args, { encoding: "utf8" });
const libs = () => readdirSync(join(appdir, "usr/lib")).sort();

describe("linuxdeploy-plugin-gtk.sh", () => {
  it("leaves no host-only library in the AppDir", () => {
    run("--appdir", appdir);
    expect(bundledHostLibs(libs().map((f) => `usr/lib/${f}`))).toEqual([]);
    expect(libs()).toEqual(["im-wayland.so", "libepoxy.so.0"]);
  });

  it("passes the API version query through", () => {
    expect(run("--plugin-api-version").trim()).toBe("0");
  });
});
