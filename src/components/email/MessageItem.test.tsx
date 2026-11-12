import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { MessageItem } from "./MessageItem";
import type { DbMessage } from "@/services/db/messages";
import type { LinkAnalysis } from "@/utils/phishingDetector";

const { recordRendererProps, mockScanMessageLinks, mockAddToPhishingAllowlist } = vi.hoisted(() => ({
  recordRendererProps: vi.fn(),
  mockScanMessageLinks: vi.fn(),
  mockAddToPhishingAllowlist: vi.fn(),
}));

vi.mock("./EmailRenderer", () => ({
  EmailRenderer: (props: Record<string, unknown>) => {
    recordRendererProps(props);
    return <div data-testid="email-renderer" />;
  },
}));

vi.mock("@/services/phishing/phishingScanner", () => ({
  scanMessageLinks: (...args: unknown[]) => mockScanMessageLinks(...args),
}));

vi.mock("@/services/db/phishingAllowlist", () => ({
  addToPhishingAllowlist: (...args: unknown[]) => mockAddToPhishingAllowlist(...args),
}));

vi.mock("./InlineAttachmentPreview", () => ({
  InlineAttachmentPreview: () => null,
}));

vi.mock("./AttachmentList", () => ({
  AttachmentList: () => null,
  getAttachmentsForMessage: vi.fn().mockResolvedValue([]),
}));

vi.mock("./AuthBadge", () => ({
  AuthBadge: () => null,
}));

vi.mock("./AuthWarningBanner", () => ({
  AuthWarningBanner: () => null,
}));

function makeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "m1",
    account_id: "a1",
    thread_id: "t1",
    from_address: "bob@example.com",
    from_name: "Bob",
    to_addresses: "alice@example.com",
    cc_addresses: null,
    bcc_addresses: null,
    reply_to: null,
    subject: "Test subject",
    snippet: "Test snippet",
    date: Date.now(),
    is_read: 0,
    is_starred: 0,
    body_html: "<p>Hello</p>",
    body_text: "Hello",
    body_cached: 1,
    raw_size: 100,
    internal_date: null,
    list_unsubscribe: null,
    list_unsubscribe_post: null,
    auth_results: null,
    message_id_header: null,
    references_header: null,
    in_reply_to_header: null,
    ...overrides,
  };
}

function makeLink(overrides: Partial<LinkAnalysis> = {}): LinkAnalysis {
  return {
    url: "http://192.168.1.1/login",
    displayText: "Verify now",
    riskScore: 55,
    riskLevel: "medium",
    triggeredRules: [],
    ...overrides,
  };
}

function makeScan(overrides: { showBanner?: boolean; links?: LinkAnalysis[]; riskyLinks?: LinkAnalysis[] } = {}) {
  const links = overrides.links ?? [makeLink()];
  return {
    result: {
      messageId: "m1",
      links,
      maxRiskScore: 55,
      suspiciousLinkCount: links.length,
      showBanner: overrides.showBanner ?? true,
      scannedAt: 1_700_000_000_000,
    },
    riskyLinks: overrides.riskyLinks ?? links,
  };
}

describe("MessageItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScanMessageLinks.mockResolvedValue(null);
    mockAddToPhishingAllowlist.mockResolvedValue(undefined);
  });

  it("renders sender name", () => {
    render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("hands the renderer the same inline attachment list on a re-render", async () => {
    // A new array per render re-runs the renderer's cid effect, and on IMAP
    // every run fetches each inline image from the server again.
    const { rerender } = render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} focused={false} />);
    await act(async () => {});
    rerender(<MessageItem message={makeMessage()} isLast={true} blockImages={false} focused={true} />);

    const calls = recordRendererProps.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[calls.length - 1]![0].inlineAttachments).toBe(calls[calls.length - 2]![0].inlineAttachments);
  });

  it("applies red background when isSpam is true", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} isSpam={true} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("bg-danger/5");
  });

  it("does not apply red background when isSpam is false", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} isSpam={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("bg-danger");
  });

  it("does not apply red background when isSpam is undefined", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("bg-danger");
  });

  it("applies focus ring when focused prop is true", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={true} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("shadow-[inset_2px_0_0_var(--color-text-primary)]");
  });

  it("does not apply focus ring when focused is false", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("shadow-[inset_2px_0_0_var(--color-text-primary)]");
  });

  it("auto-expands when focused becomes true", () => {
    // Render collapsed (isLast=false, not focused)
    const { container, rerender } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={false} />,
    );
    // Should be collapsed — no email renderer visible
    expect(container.querySelector("[data-testid='email-renderer']")).toBeNull();

    // Now set focused=true
    rerender(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={true} />,
    );
    // Should now be expanded — email renderer visible
    expect(container.querySelector("[data-testid='email-renderer']")).toBeInTheDocument();
  });

  it("forwards ref to outer div", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MessageItem ref={ref} message={makeMessage()} isLast={true} blockImages={false} />,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  describe("phishing detection", () => {
    it("scans the expanded message body", async () => {
      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      await waitFor(() => {
        // The plain-text body goes with it: a message with no HTML part still
        // gets clickable links from the renderer, so it has to be scanned.
        expect(mockScanMessageLinks).toHaveBeenCalledWith(
          "a1",
          "m1",
          "<p>Hello</p>",
          "bob@example.com",
          expect.anything(),
        );
      });
    });

    it("does not scan while the message is collapsed", () => {
      render(<MessageItem message={makeMessage()} isLast={false} blockImages={false} />);

      expect(mockScanMessageLinks).not.toHaveBeenCalled();
    });

    it("shows the banner when the scan asks for it", async () => {
      mockScanMessageLinks.mockResolvedValue(makeScan());

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      expect(await screen.findByText("1 suspicious link found", { exact: false })).toBeInTheDocument();
    });

    it("stays quiet when the scan reports nothing worth showing", async () => {
      mockScanMessageLinks.mockResolvedValue(makeScan({ showBanner: false }));

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      await waitFor(() => expect(mockScanMessageLinks).toHaveBeenCalled());
      expect(screen.queryByText("Trust this sender")).not.toBeInTheDocument();
    });

    it("stays quiet when scanning is disabled", async () => {
      mockScanMessageLinks.mockResolvedValue(null);

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      await waitFor(() => expect(mockScanMessageLinks).toHaveBeenCalled());
      expect(screen.queryByText("Trust this sender")).not.toBeInTheDocument();
    });

    it("allowlists the sender and drops the warning when the sender is trusted", async () => {
      mockScanMessageLinks.mockResolvedValue(makeScan());

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      const trust = await screen.findByText("Trust this sender");
      fireEvent.click(trust);

      await waitFor(() => {
        expect(mockAddToPhishingAllowlist).toHaveBeenCalledWith("a1", "bob@example.com");
      });
      expect(screen.queryByText("Trust this sender")).not.toBeInTheDocument();
      expect(recordRendererProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ riskyLinks: [] }),
      );
    });

    it("hands the risky links to the renderer", async () => {
      const links = [makeLink()];
      mockScanMessageLinks.mockResolvedValue(makeScan({ links, riskyLinks: links }));

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      await waitFor(() => {
        expect(recordRendererProps).toHaveBeenLastCalledWith(
          expect.objectContaining({ riskyLinks: links }),
        );
      });
    });

    it("survives a failing scan", async () => {
      mockScanMessageLinks.mockRejectedValue(new Error("db is gone"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);

      await waitFor(() => expect(mockScanMessageLinks).toHaveBeenCalled());
      expect(screen.getByTestId("email-renderer")).toBeInTheDocument();
      errorSpy.mockRestore();
    });
  });
});
