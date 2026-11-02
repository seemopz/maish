// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUpdaterJson } from "./build-updater-json.mjs";

// Asset list, .sig contents and latest.json of the 0.11.0 release, written by
// tauri-action while the three builds still ran one after another.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/release-0.11.0.json"), "utf8"));
const build = (assets = fixture.assets, signatures = fixture.signatures) =>
  buildUpdaterJson({
    version: "0.11.0",
    notes: fixture.latest.notes,
    pubDate: fixture.latest.pub_date,
    assets,
    signatures,
  });

describe("buildUpdaterJson", () => {
  it("reproduces the latest.json tauri-action wrote for 0.11.0", () => {
    expect(build()).toEqual(fixture.latest);
  });

  it("points each platform at the asset its signature belongs to", () => {
    const { platforms } = build();
    const name = (url) => fixture.assets.find((a) => a.url === url).name;
    expect(name(platforms["linux-x86_64"].url)).toBe("Maish_0.11.0_amd64.AppImage");
    expect(name(platforms["windows-x86_64"].url)).toBe("Maish_0.11.0_x64-setup.exe");
    expect(name(platforms["darwin-aarch64"].url)).toBe("Maish_0.11.0_aarch64.app.tar.gz");
  });

  it("skips a signature whose bundle is missing", () => {
    const assets = fixture.assets.filter((a) => a.name !== "Maish_0.11.0_amd64.deb");
    expect(build(assets).platforms).not.toHaveProperty("linux-x86_64-deb");
  });

  it("refuses a .sig it cannot map to a platform", () => {
    const assets = [...fixture.assets, { name: "Maish_0.11.0.tar.xz.sig", url: "https://api.github.com/x" }];
    expect(() => build(assets, { ...fixture.signatures, "Maish_0.11.0.tar.xz.sig": "x" })).toThrow(
      /Maish_0.11.0.tar.xz.sig/,
    );
  });
});
