// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, shouldRetry } from "./release-retry.mjs";

// Jobs of real release runs, trimmed to the fields the decision reads.
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/release-run-jobs.json"), "utf8"));

describe("shouldRetry", () => {
  it("retries a job GitHub cancelled because no runner picked it up (0.11.1 macOS)", () => {
    expect(shouldRetry(fx.runnerNotAcquired, 1)).toBe(true);
  });

  it("does not retry a build that ran and failed", () => {
    expect(shouldRetry(fx.realFailureToday, 1)).toBe(false);
    expect(shouldRetry(fx.realFailureMacOS, 1)).toBe(false);
  });

  // A re-run of failed jobs would repeat the real failure too; that needs a person.
  it("does not retry when a real failure sits next to a runner problem", () => {
    expect(shouldRetry(fx.mixedToday, 1)).toBe(false);
  });

  it("has nothing to retry in a successful run", () => {
    expect(shouldRetry(fx.success, 1)).toBe(false);
  });

  it("gives up after the last allowed attempt", () => {
    expect(shouldRetry(fx.runnerNotAcquired, MAX_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetry(fx.runnerNotAcquired, MAX_ATTEMPTS)).toBe(false);
  });
});
