import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const { mockUndo } = vi.hoisted(() => ({ mockUndo: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/services/undoableActions", () => ({
  undoPending: mockUndo,
  UNDO_WINDOW_MS: 5000,
}));

import { UndoActionToast } from "./UndoActionToast";
import { useUndoStore } from "@/stores/undoStore";

describe("UndoActionToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUndoStore.setState({ message: null, token: 0 });
  });

  it("renders nothing while there is nothing to undo", () => {
    render(<UndoActionToast />);
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("shows the action text with an Undo button that undoes the batch", () => {
    render(<UndoActionToast />);
    act(() => useUndoStore.getState().show("3 conversations archived"));

    expect(screen.getByText("3 conversations archived")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo"));
    expect(mockUndo).toHaveBeenCalledTimes(1);
  });
});
