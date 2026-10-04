import { clampMailZoom, parseMailZoom, MAIL_ZOOM_MAX, MAIL_ZOOM_MIN } from "./mailZoom";

describe("mailZoom", () => {
  it("keeps the factor inside the range and rounds to whole percent", () => {
    expect(clampMailZoom(0.1)).toBe(MAIL_ZOOM_MIN);
    expect(clampMailZoom(9)).toBe(MAIL_ZOOM_MAX);
    expect(clampMailZoom(1.2345)).toBe(1.23);
  });

  it("falls back to 100 % for a factor that is not a number", () => {
    expect(clampMailZoom(NaN)).toBe(1);
    expect(clampMailZoom(Infinity)).toBe(1);
  });

  it("reads a saved factor and rejects garbage", () => {
    expect(parseMailZoom("1.5")).toBe(1.5);
    expect(parseMailZoom("99")).toBe(MAIL_ZOOM_MAX);
    expect(parseMailZoom("abc")).toBeNull();
    expect(parseMailZoom(null)).toBeNull();
  });
});
