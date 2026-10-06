import { clampMailZoom, roundMailZoom, parseMailZoom, mailZoomKey, MAIL_ZOOM_MAX, MAIL_ZOOM_MIN } from "./mailZoom";

describe("mailZoom", () => {
  it("keeps the factor inside the range without rounding it", () => {
    expect(clampMailZoom(0.1)).toBe(MAIL_ZOOM_MIN);
    expect(clampMailZoom(9)).toBe(MAIL_ZOOM_MAX);
    expect(clampMailZoom(1.2345)).toBe(1.2345);
  });

  it("rounds to whole percent", () => {
    expect(roundMailZoom(1.2345)).toBe(1.23);
  });

  it("falls back to 100 % for a factor that is not a number", () => {
    expect(clampMailZoom(NaN)).toBe(1);
    expect(clampMailZoom(Infinity)).toBe(1);
  });

  it("reads a saved factor and rejects garbage", () => {
    expect(parseMailZoom("1.5")).toBe(1.5);
    expect(parseMailZoom("1.2345")).toBe(1.23);
    expect(parseMailZoom("99")).toBe(MAIL_ZOOM_MAX);
    expect(parseMailZoom("abc")).toBeNull();
    expect(parseMailZoom(null)).toBeNull();
  });

  describe("mailZoomKey", () => {
    const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
      mailZoomKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

    it("maps Ctrl or Cmd with +, =, -, _ and 0", () => {
      expect(press("+", { ctrlKey: true })).toBe("in");
      expect(press("=", { metaKey: true })).toBe("in");
      expect(press("-", { ctrlKey: true })).toBe("out");
      expect(press("_", { metaKey: true })).toBe("out");
      expect(press("0", { ctrlKey: true })).toBe("reset");
    });

    it("ignores the keys without Ctrl/Cmd, with Alt, and other keys", () => {
      expect(press("+")).toBeNull();
      expect(press("+", { ctrlKey: true, altKey: true })).toBeNull();
      expect(press("9", { ctrlKey: true })).toBeNull();
    });
  });
});
