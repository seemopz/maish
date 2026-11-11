// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledHostLibs } from "./verify-appimage-libs.mjs";

const SCRIPT = join(import.meta.dirname, "verify-appimage-libs.mjs");

// Stands in for an AppImage: `--appimage-extract` unpacks into ./squashfs-root.
function fakeAppImage(dir, libs) {
  const path = join(dir, "Maish_0.0.0_amd64.AppImage");
  const touch = libs.map((l) => `touch "squashfs-root/usr/lib/${l}"`).join("\n");
  writeFileSync(path, `#! /usr/bin/env bash\nmkdir -p squashfs-root/usr/lib\n${touch}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("verify-appimage-libs.mjs", () => {
  // The release workflow passes src-tauri/target/…/*.AppImage, relative to the
  // checkout, while the script runs the AppImage inside a temporary directory.
  it("accepts a path relative to the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-appimage-"));
    try {
      fakeAppImage(dir, ["libepoxy.so.0"]);
      const r = spawnSync("node", [SCRIPT, "Maish_0.0.0_amd64.AppImage"], { cwd: dir, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on an AppImage that bundles libwayland", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-appimage-"));
    try {
      fakeAppImage(dir, ["libwayland-client.so.0"]);
      const r = spawnSync("node", [SCRIPT, "Maish_0.0.0_amd64.AppImage"], { cwd: dir, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("usr/lib/libwayland-client.so.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The usr/lib listing of the 0.11.0 AppImage, cut down to the interesting part.
const RELEASE_0_11_0 = [
  "usr/lib/libepoxy.so.0",
  "usr/lib/libffi.so.8",
  "usr/lib/libglib-2.0.so.0",
  "usr/lib/libwayland-client.so.0",
  "usr/lib/libwayland-cursor.so.0",
  "usr/lib/libwayland-egl.so.1",
  "usr/lib/libwayland-server.so.0",
  "usr/lib/libxcb-shm.so.0",
  "usr/lib/gtk-3.0/3.0.0/immodules/im-wayland.so",
];

describe("bundledHostLibs", () => {
  it("reports the libwayland copies that broke 0.11.0 on Arch", () => {
    expect(bundledHostLibs(RELEASE_0_11_0)).toEqual([
      "usr/lib/libwayland-client.so.0",
      "usr/lib/libwayland-cursor.so.0",
      "usr/lib/libwayland-egl.so.1",
      "usr/lib/libwayland-server.so.0",
    ]);
  });

  it("accepts a bundle without them", () => {
    const fixed = RELEASE_0_11_0.filter((p) => !p.includes("libwayland-"));
    expect(bundledHostLibs(fixed)).toEqual([]);
  });

  it("does not mistake the GTK Wayland input module for libwayland", () => {
    expect(bundledHostLibs(["usr/lib/im-wayland.so", "usr/lib/im-waylandgtk.so"])).toEqual([]);
  });
});
