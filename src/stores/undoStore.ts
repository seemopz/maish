import { create } from "zustand";

interface UndoState {
  /** Text of the toast, or null while nothing can be undone. */
  message: string | null;
  /** Bumped per toast so the countdown bar restarts when a new batch replaces the old one. */
  token: number;
  show: (message: string) => void;
  hide: () => void;
}

export const useUndoStore = create<UndoState>((set) => ({
  message: null,
  token: 0,
  show: (message) => set((s) => ({ message, token: s.token + 1 })),
  hide: () => set({ message: null }),
}));
