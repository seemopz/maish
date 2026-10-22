import { describe, it, expect } from "vitest";
import { HUES, CATEGORY_HUES, categoryHue, senderHue } from "./hue";

describe("senderHue", () => {
  it("returns the same hue for the same address, whatever the case and padding", () => {
    expect(senderHue("Alice@Example.com")).toBe(senderHue(" alice@example.com "));
  });

  it("always returns one of the checked hues", () => {
    for (const address of ["", "a", "bob@example.org", "x".repeat(500)]) {
      expect(HUES).toContain(senderHue(address));
    }
  });

  it("spreads different senders over several hues", () => {
    const hues = new Set(
      Array.from({ length: 50 }, (_, i) => senderHue(`sender${i}@example.com`)),
    );
    expect(hues.size).toBeGreaterThanOrEqual(8);
  });
});

describe("categoryHue", () => {
  it("only uses checked hues", () => {
    for (const hue of CATEGORY_HUES.values()) expect(HUES).toContain(hue);
  });

  it("has no hue for Primary or for names inherited from Object.prototype", () => {
    expect(categoryHue("Social")).toBe(315);
    for (const name of ["Primary", "constructor", "toString", "__proto__"]) {
      expect(categoryHue(name)).toBeUndefined();
    }
  });
});
