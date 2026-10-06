import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { OfflineBanner } from "./OfflineBanner";

describe("OfflineBanner", () => {
  beforeEach(() => {
    useUIStore.setState({ isOnline: true });
  });

  it("renders nothing while online", () => {
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not position itself, so it cannot overlap the startup errors", () => {
    useUIStore.setState({ isOnline: false });
    const { container } = render(<OfflineBanner />);
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect((container.firstChild as HTMLElement).className).not.toMatch(/\bfixed\b/);
  });
});
