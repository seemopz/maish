import { describe, it, expect } from "vitest";
import { base64UrlEncode } from "./base64url";

describe("base64UrlEncode", () => {
  it("uses the URL-safe alphabet and drops padding", () => {
    // 0xfb 0xff encodes to "+/8=" in standard base64
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("encodes a string as UTF-8", () => {
    expect(base64UrlEncode("héllo")).toBe("aMOpbGxv");
    expect(base64UrlEncode("a")).toBe("YQ");
  });

  it("returns an empty string for empty input", () => {
    expect(base64UrlEncode("")).toBe("");
    expect(base64UrlEncode(new Uint8Array())).toBe("");
  });
});
