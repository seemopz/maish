import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { StartupErrorBanner } from "./StartupErrorBanner";

describe("StartupErrorBanner", () => {
  beforeEach(() => {
    useUIStore.setState({ startupErrors: [] });
  });

  it("renders nothing without an error", () => {
    const { container } = render(<StartupErrorBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the error as an alert", () => {
    useUIStore.setState({ startupErrors: ["Could not decrypt the IMAP password of a@b.c"] });
    render(<StartupErrorBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not decrypt the IMAP password of a@b.c");
  });

  it("stacks several errors, one alert each", () => {
    useUIStore.setState({ startupErrors: ["first problem", "second problem"] });
    render(<StartupErrorBanner />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("first problem");
    expect(alerts[1]).toHaveTextContent("second problem");
  });

  it("does not position itself, so it cannot overlap the offline banner", () => {
    // The banners are stacked by their shared container in App.
    useUIStore.setState({ startupErrors: ["x"] });
    render(<StartupErrorBanner />);
    expect(screen.getByRole("alert").className).not.toMatch(/\bfixed\b/);
  });
});
