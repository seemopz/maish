import { describe, it, expect } from "vitest";
import { stripRemoteImages, hasBlockedImages } from "./imageBlocker";

describe("stripRemoteImages", () => {
  it("blocks remote http images", () => {
    const html = '<img src="http://tracker.example.com/pixel.gif" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="http://tracker.example.com/pixel.gif"');
    // The original src should be replaced with empty string
    expect(result).toContain('src=""');
    // Make sure original src= with URL is gone (not counting the data-blocked-src)
    expect(result.replace(/data-blocked-src="[^"]*"/g, "")).not.toContain('src="http://');
  });

  it("blocks remote https images", () => {
    const html = '<img src="https://cdn.example.com/image.png" alt="photo" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="https://cdn.example.com/image.png"');
  });

  it("blocks a protocol-relative remote image", () => {
    // The frame's base URL decides the scheme here, so the app cannot tell
    // from the markup alone whether the policy would let this through.
    const html = '<img src="//tracker.example.com/pixel.gif" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="//tracker.example.com/pixel.gif"');
    expect(result.replace(/data-blocked-src="[^"]*"/g, "")).not.toContain(
      "//tracker.example.com",
    );
  });

  it("preserves data: URIs", () => {
    const html = '<img src="data:image/png;base64,iVBOR..." />';
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("preserves cid: URIs", () => {
    const html = '<img src="cid:image001@example.com" />';
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("handles multiple images", () => {
    const html = '<img src="https://a.com/1.png" /><img src="https://b.com/2.png" />';
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="https://a.com/1.png"');
    expect(result).toContain('data-blocked-src="https://b.com/2.png"');
  });

  it("handles single-quoted src", () => {
    const html = "<img src='https://cdn.example.com/img.jpg' />";
    const result = stripRemoteImages(html);
    expect(result).toContain('data-blocked-src="https://cdn.example.com/img.jpg"');
  });

  // Browsers read a backslash as a slash in an http(s) URL and drop tabs
  // inside it, and a serialised attribute value may hold a raw ">".
  it.each([
    [String.raw`<img src="https:\\t.example\p.gif">`, "backslashes"],
    ['<img src="ht	tps://t.example/p.gif">', "a tab in the scheme"],
    ['<img alt="a>b" src="https://t.example/p.gif">', "a > in an earlier attribute"],
  ])("blocks %s (%s)", (html) => {
    const img = new DOMParser().parseFromString(stripRemoteImages(html), "text/html").querySelector("img");
    expect(img?.getAttribute("src")).toBe("");
  });

  it("handles HTML with no images", () => {
    const html = "<p>Hello world</p>";
    const result = stripRemoteImages(html);
    expect(result).toBe(html);
  });

  it("strips url() in inline CSS", () => {
    const html = '<div style="background-image: url(https://tracker.com/bg.png)">text</div>';
    const result = stripRemoteImages(html);
    expect(result).not.toContain("https://tracker.com/bg.png");
  });

  it("strips a protocol-relative url() in inline CSS", () => {
    const html = '<div style="background-image: url(//tracker.com/bg.png)">text</div>';
    const result = stripRemoteImages(html);
    expect(result).not.toContain("//tracker.com/bg.png");
  });

  it("leaves a document-relative url() alone", () => {
    const html = '<div style="background-image: url(/local/bg.png)">text</div>';
    expect(stripRemoteImages(html)).toBe(html);
  });
});

describe("hasBlockedImages", () => {
  it("returns true when blocked images exist", () => {
    const html = '<img data-blocked-src="https://cdn.example.com/img.png" src="" />';
    expect(hasBlockedImages(html)).toBe(true);
  });

  it("returns true for a blocked protocol-relative image", () => {
    const html = '<img data-blocked-src="//cdn.example.com/img.png" src="" />';
    expect(hasBlockedImages(html)).toBe(true);
  });

  it("returns false when no blocked images", () => {
    const html = '<img src="https://cdn.example.com/img.png" />';
    expect(hasBlockedImages(html)).toBe(false);
  });

  it("returns false for empty HTML", () => {
    expect(hasBlockedImages("")).toBe(false);
  });

  it("returns false for data-blocked-src with data: URI", () => {
    const html = '<img data-blocked-src="data:image/png;base64,abc" />';
    expect(hasBlockedImages(html)).toBe(false);
  });
});
