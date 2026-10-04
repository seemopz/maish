import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/logFile", () => ({ logToFile: vi.fn() }));

import { useUndoStore } from "@/stores/undoStore";
import {
  registerUndoable,
  flushPendingUndo,
  undoPending,
  undoBatch,
  UNDO_WINDOW_MS,
} from "./undoableActions";

function item() {
  return { commit: vi.fn(() => Promise.resolve()), revert: vi.fn(() => Promise.resolve()) };
}
const describeN = (n: number) => `${n} done`;

describe("undoableActions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUndoStore.setState({ message: null, token: 0 });
  });

  afterEach(async () => {
    await flushPendingUndo();
    vi.useRealTimers();
  });

  it("holds the commit back and shows the toast", () => {
    const a = item();
    registerUndoable("archive", describeN, a);
    expect(a.commit).not.toHaveBeenCalled();
    expect(useUndoStore.getState().message).toBe("1 done");
  });

  it("commits once the undo window has passed", async () => {
    const a = item();
    registerUndoable("archive", describeN, a);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(a.revert).not.toHaveBeenCalled();
    expect(useUndoStore.getState().message).toBeNull();
  });

  it("undo reverts instead of committing, and reloads the list", async () => {
    const reload = vi.fn();
    window.addEventListener("maish-sync-done", reload);
    const a = item();
    registerUndoable("archive", describeN, a);

    expect(await undoPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);

    expect(a.revert).toHaveBeenCalledTimes(1);
    expect(a.commit).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().message).toBeNull();
    window.removeEventListener("maish-sync-done", reload);
  });

  it("undo with nothing pending does nothing", async () => {
    expect(await undoPending()).toBe(false);
  });

  it("merges calls of one kind in quick succession into one toast and one undo", async () => {
    const [a, b, c] = [item(), item(), item()];
    registerUndoable("trash", describeN, a);
    registerUndoable("trash", describeN, b);
    registerUndoable("trash", describeN, c);
    expect(useUndoStore.getState().message).toBe("3 done");

    await undoPending();
    expect([a, b, c].every((i) => i.revert.mock.calls.length === 1)).toBe(true);
    expect([a, b, c].some((i) => i.commit.mock.calls.length > 0)).toBe(false);
  });

  it("a different kind commits the earlier batch and starts its own", async () => {
    const a = item();
    const b = item();
    registerUndoable("archive", describeN, a);
    registerUndoable("trash", describeN, b);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.commit).toHaveBeenCalledTimes(1);
    await undoPending();
    expect(a.revert).not.toHaveBeenCalled();
    expect(b.revert).toHaveBeenCalledTimes(1);
  });

  it("a call after the batch gap starts a new batch", async () => {
    const a = item();
    const b = item();
    registerUndoable("archive", describeN, a);
    await vi.advanceTimersByTimeAsync(1500);
    registerUndoable("archive", describeN, b);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().message).toBe("1 done");
  });

  it("an explicit batch stays one batch however far apart the calls are", async () => {
    const [a, b] = [item(), item()];
    await undoBatch(async () => {
      registerUndoable("archive", describeN, a);
      await vi.advanceTimersByTimeAsync(3000);
      registerUndoable("archive", describeN, b);
    });
    expect(a.commit).not.toHaveBeenCalled();
    expect(useUndoStore.getState().message).toBe("2 done");

    await undoPending();
    expect(a.revert).toHaveBeenCalledTimes(1);
    expect(b.revert).toHaveBeenCalledTimes(1);
  });

  it("a failing commit does not stop the others", async () => {
    const a = item();
    a.commit.mockRejectedValueOnce(new Error("boom"));
    const b = item();
    registerUndoable("archive", describeN, a);
    registerUndoable("archive", describeN, b);
    await flushPendingUndo();
    expect(b.commit).toHaveBeenCalledTimes(1);
  });
});
