// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bundledHostLibs } from "./verify-appimage-libs.mjs";

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
