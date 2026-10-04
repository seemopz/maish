import { render, waitFor, screen, fireEvent, act } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmailRenderer } from "./EmailRenderer";
import type { DbAttachment } from "@/services/db/attachments";
import type { LinkAnalysis } from "@/utils/phishingDetector";

// Mock dependencies
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/sanitize", () => ({
  sanitizeHtml: (html: string) => html,
  escapeHtml: (text: string) => text,
}));

vi.mock("@/services/db/imageAllowlist", () => ({
  addToAllowlist: vi.fn(),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: "light" }),
}));

const mockFetchAttachment = vi.fn();

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn().mockResolvedValue({
    fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
  }),
}));

// Mock ResizeObserver for jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

function makeAttachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "icon.png",
    mime_type: "image/png",
    size: 1024,
    gmail_attachment_id: "gmail-att-1",
    content_id: "icon@example.com",
    is_inline: 1,
    local_path: null,
    ...overrides,
  };
}

describe("EmailRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders plain text when no html provided", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Hello world" />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("turns URLs in a plain text body into anchors", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Go to https://example.com/x now" />,
    );

    const srcDoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain(
      '<a href="https://example.com/x">https://example.com/x</a>',
    );
  });

  it("leaves an html body's own markup untouched", () => {
    const { container } = render(
      <EmailRenderer html="<p>Go to https://example.com/x now</p>" text={null} />,
    );

    const srcDoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("<p>Go to https://example.com/x now</p>");
  });

  it("renders html content in iframe", () => {
    const { container } = render(
      <EmailRenderer html="<p>Hello</p>" text={null} />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("resolves cid: references by fetching inline attachment data", async () => {
    const base64Data = btoa("fake-image-data");
    mockFetchAttachment.mockResolvedValue({ data: base64Data, size: 100 });

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "gmail-att-1");
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("skips cid resolution when no inline attachments", () => {
    render(
      <EmailRenderer
        html='<img src="cid:missing@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={[]}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("skips cid resolution when accountId or messageId missing", () => {
    const inlineAttachments = [makeAttachment()];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    mockFetchAttachment.mockRejectedValue(new Error("Network error"));

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalled();
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("resolves multiple cid references", async () => {
    mockFetchAttachment
      .mockResolvedValueOnce({ data: btoa("img1"), size: 50 })
      .mockResolvedValueOnce({ data: btoa("img2"), size: 60 });

    const inlineAttachments = [
      makeAttachment({ id: "att-1", content_id: "img1@ex.com", gmail_attachment_id: "g1" }),
      makeAttachment({ id: "att-2", content_id: "img2@ex.com", gmail_attachment_id: "g2", mime_type: "image/jpeg" }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:img1@ex.com" /><img src="cid:img2@ex.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledTimes(2);
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g1");
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g2");
    });
  });

  describe("link handling", () => {
    function renderWithFrame(html: string) {
      const { container } = render(<EmailRenderer html={html} text={null} />);
      const iframe = container.querySelector("iframe") as HTMLIFrameElement;
      return { iframe };
    }

    function postFromFrame(iframe: HTMLIFrameElement, data: unknown, source?: unknown) {
      const event = new MessageEvent("message", { data });
      Object.defineProperty(event, "source", {
        value: source === undefined ? iframe.contentWindow : source,
      });
      window.dispatchEvent(event);
    }

    it("replays a wheel report from the frame as a bubbling wheel event on the iframe", () => {
      const { iframe } = renderWithFrame("<p>hi</p>");
      const seen: WheelEvent[] = [];
      document.addEventListener("wheel", (e) => seen.push(e), { once: true });

      postFromFrame(iframe, { type: "maish:wheel", deltaX: 7, deltaY: 1, deltaMode: 1 });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ deltaX: 7, deltaY: 1, deltaMode: 1, target: iframe });
    });

    it("drops a wheel report from another window or with bad numbers", () => {
      const { iframe } = renderWithFrame("<p>hi</p>");
      const seen: WheelEvent[] = [];
      const onWheel = (e: WheelEvent) => seen.push(e);
      document.addEventListener("wheel", onWheel);

      postFromFrame(iframe, { type: "maish:wheel", deltaX: 7, deltaY: 1 }, window);
      postFromFrame(iframe, { type: "maish:wheel", deltaX: "7", deltaY: 1 });
      expect(() => postFromFrame(iframe, { type: "maish:wheel", deltaX: NaN, deltaY: 1 })).not.toThrow();
      postFromFrame(iframe, { type: "maish:wheel", deltaX: Infinity, deltaY: 1 });
      document.removeEventListener("wheel", onWheel);

      expect(seen).toHaveLength(0);
    });

    it("opens a link the frame reports via the system opener", () => {
      const { iframe } = renderWithFrame('<a href="https://example.com/x">go</a>');

      postFromFrame(iframe, { type: "maish:link", url: "https://example.com/x" });

      expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
    });

    it("opens mailto: links reported by the frame", () => {
      const { iframe } = renderWithFrame('<a href="mailto:a@b.c">mail</a>');

      postFromFrame(iframe, { type: "maish:link", url: "mailto:a@b.c" });

      expect(openUrl).toHaveBeenCalledWith("mailto:a@b.c");
    });

    it("ignores messages that did not come from its own frame", () => {
      const { iframe } = renderWithFrame('<a href="https://example.com/x">go</a>');

      postFromFrame(iframe, { type: "maish:link", url: "https://evil.example/x" }, window);

      expect(openUrl).not.toHaveBeenCalled();
    });

    it("refuses schemes outside the allowlist", () => {
      const { iframe } = renderWithFrame("<p>body</p>");

      postFromFrame(iframe, { type: "maish:link", url: "javascript:alert(1)" });
      postFromFrame(iframe, { type: "maish:link", url: "file:///etc/passwd" });

      expect(openUrl).not.toHaveBeenCalled();
    });

    it("sizes the iframe from the height the frame reports", () => {
      const { iframe } = renderWithFrame("<p>body</p>");

      postFromFrame(iframe, { type: "maish:height", height: 420 });

      expect(iframe.style.height).toBe("420px");
    });

    describe("risky links", () => {
      function makeLink(overrides: Partial<LinkAnalysis> = {}): LinkAnalysis {
        return {
          url: "http://192.168.1.1/login",
          displayText: "Verify now",
          riskScore: 55,
          riskLevel: "medium",
          triggeredRules: [
            {
              ruleId: "ip-address",
              name: "IP Address URL",
              score: 40,
              detail: "URL points to raw IP address: 192.168.1.1",
            },
          ],
          ...overrides,
        };
      }

      function renderWithRisky(riskyLinks: LinkAnalysis[]) {
        const { container } = render(
          <EmailRenderer html="<p>body</p>" text={null} riskyLinks={riskyLinks} />,
        );
        return { iframe: container.querySelector("iframe") as HTMLIFrameElement };
      }

      // The frame's message arrives outside React's event system, so the
      // resulting render has to be flushed explicitly.
      function clickLink(iframe: HTMLIFrameElement, url: string) {
        act(() => postFromFrame(iframe, { type: "maish:link", url }));
      }

      it("asks before opening a link the scan flagged", () => {
        const { iframe } = renderWithRisky([makeLink()]);

        clickLink(iframe, "http://192.168.1.1/login");

        expect(openUrl).not.toHaveBeenCalled();
        expect(screen.getByText("Suspicious Link")).toBeInTheDocument();
        expect(screen.getByText("IP Address URL")).toBeInTheDocument();
      });

      it("labels a high-risk link as such", () => {
        const { iframe } = renderWithRisky([makeLink({ riskScore: 70, riskLevel: "high" })]);

        clickLink(iframe, "http://192.168.1.1/login");

        expect(screen.getByText("High Risk Link")).toBeInTheDocument();
      });

      it("opens the link once the user confirms", () => {
        const { iframe } = renderWithRisky([makeLink()]);

        clickLink(iframe, "http://192.168.1.1/login");
        fireEvent.click(screen.getByText("Open Anyway"));

        expect(openUrl).toHaveBeenCalledWith("http://192.168.1.1/login");
        expect(screen.queryByText("Suspicious Link")).not.toBeInTheDocument();
      });

      it("leaves the link unopened when the user goes back", () => {
        const { iframe } = renderWithRisky([makeLink()]);

        clickLink(iframe, "http://192.168.1.1/login");
        fireEvent.click(screen.getByText("Go Back"));

        expect(openUrl).not.toHaveBeenCalled();
        expect(screen.queryByText("Suspicious Link")).not.toBeInTheDocument();
      });

      it("opens a link that is not on the risky list straight away", () => {
        const { iframe } = renderWithRisky([makeLink()]);

        clickLink(iframe, "https://example.com/x");

        expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
        expect(screen.queryByText("Suspicious Link")).not.toBeInTheDocument();
      });

      it("matches the resolved URL the frame reports against the scanned href", () => {
        const { iframe } = renderWithRisky([makeLink({ url: "https://bit.ly" })]);

        clickLink(iframe, "https://bit.ly/");

        expect(openUrl).not.toHaveBeenCalled();
        expect(screen.getByText("Suspicious Link")).toBeInTheDocument();
      });

      it("shows the URL that will actually open", () => {
        const { iframe } = renderWithRisky([makeLink({ url: "https://bit.ly" })]);

        clickLink(iframe, "https://bit.ly/");

        expect(screen.getByText("https://bit.ly/")).toBeInTheDocument();
      });

      it("still refuses schemes outside the allowlist", () => {
        const { iframe } = renderWithRisky([makeLink({ url: "javascript:alert(1)" })]);

        clickLink(iframe, "javascript:alert(1)");

        expect(openUrl).not.toHaveBeenCalled();
        expect(screen.queryByText("Suspicious Link")).not.toBeInTheDocument();
      });
    });

    it("keeps the frame sandboxed without same-origin access", () => {
      const { iframe } = renderWithFrame("<p>body</p>");

      const sandbox = iframe.getAttribute("sandbox") ?? "";
      expect(sandbox.split(/\s+/)).not.toContain("allow-same-origin");
    });
  });

  it("ignores attachments without content_id or gmail_attachment_id", () => {
    const inlineAttachments = [
      makeAttachment({ content_id: null }),
      makeAttachment({ id: "att-2", gmail_attachment_id: null }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });
});
