import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { StartupErrorBanner } from "./StartupErrorBanner";

describe("StartupErrorBanner", () => {
  beforeEach(() => {
    useUIStore.setState({ startupError: null });
  });

  it("renders nothing without an error", () => {
    const { container } = render(<StartupErrorBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the error as an alert", () => {
    useUIStore.setState({ startupError: "Could not decrypt the IMAP password of a@b.c" });
    render(<StartupErrorBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not decrypt the IMAP password of a@b.c");
  });
});
