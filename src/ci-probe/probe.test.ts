import { it, expect } from "vitest";

it("deliberately failing probe for the CI gate", () => {
  expect(1).toBe(2);
});
