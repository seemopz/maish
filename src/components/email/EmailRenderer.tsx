import { useRef, useCallback, useLayoutEffect, useMemo, useState, useEffect } from "react";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripRemoteImages, hasBlockedImages } from "@/utils/imageBlocker";
import { addToAllowlist } from "@/services/db/imageAllowlist";
import { sanitizeHtml } from "@/utils/sanitize";
import { linkifyPlainText } from "@/utils/linkify";
import { useUIStore } from "@/stores/uiStore";
import { mailZoomKey } from "@/utils/mailZoom";
import { findLinkAnalysis } from "@/utils/phishingDetector";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import type { LinkAnalysis } from "@/utils/phishingDetector";
import type { DbAttachment } from "@/services/db/attachments";

// The frame is untrusted, so only schemes that are safe to hand to the system
// opener get through. Anything else is dropped silently.
const OPENABLE_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

function isOpenableUrl(url: string): boolean {
  try {
    return OPENABLE_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

interface EmailRendererProps {
  html: string | null;
  text: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  messageId?: string | null;
  inlineAttachments?: DbAttachment[];
  /** Links the phishing scan flagged — clicking one asks for confirmation first. */
  riskyLinks?: LinkAnalysis[];
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  messageId,
  inlineAttachments,
  riskyLinks,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [overrideShow, setOverrideShow] = useState(false);
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map());
  const [pendingLink, setPendingLink] = useState<LinkAnalysis | null>(null);

  const theme = useUIStore((s) => s.theme);
  const mailZoom = useUIStore((s) => s.mailZoom);
  const isDark = theme === "dark"
    || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Resolve cid: references by fetching inline attachment data
  useEffect(() => {
    if (!accountId || !messageId || !inlineAttachments?.length) return;

    const cidAttachments = inlineAttachments.filter(
      (a) => a.content_id && a.gmail_attachment_id,
    );
    if (cidAttachments.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const { getEmailProvider } = await import("@/services/email/providerFactory");
        const provider = await getEmailProvider(accountId);
        const resolved = new Map<string, string>();

        await Promise.all(
          cidAttachments.map(async (att) => {
            try {
              const response = await provider.fetchAttachment(
                messageId,
                att.gmail_attachment_id!,
              );
              const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
              resolved.set(att.content_id!, `data:${att.mime_type ?? "image/png"};base64,${base64}`);
            } catch {
              // Skip individual failures
            }
          }),
        );

        if (!cancelled && resolved.size > 0) {
          setCidMap(resolved);
        }
      } catch {
        // Non-critical — images just won't render
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, messageId, inlineAttachments]);

  // Sanitize once — reused by both content and blocked-image check
  const sanitizedBody = useMemo(() => {
    if (!html) return null;
    return sanitizeHtml(html);
  }, [html]);

  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    // A plain-text body carries no anchors of its own, so URLs in it are turned
    // into links here; `linkifyPlainText` escapes the body on the way.
    let body = sanitizedBody
      ?? `<pre style="white-space: pre-wrap; font-family: inherit;">${linkifyPlainText(text ?? "")}</pre>`;

    if (shouldBlock && sanitizedBody) {
      body = stripRemoteImages(body);
    }

    // Replace cid: references with resolved data URIs
    if (cidMap.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s)]+)/gi,
        (match, cidRef: string) => cidMap.get(cidRef) ?? match,
      );
    }

    return body;
  }, [sanitizedBody, text, shouldBlock, cidMap]);

  const blocked = useMemo(() => {
    if (!shouldBlock || !sanitizedBody) return false;
    return hasBlockedImages(stripRemoteImages(sanitizedBody));
  }, [shouldBlock, sanitizedBody]);

  // The frame is sandboxed to an opaque origin, so its content is handed over as
  // srcdoc and everything comes back over postMessage — see public/emailFrame.js
  const frameDoc = useMemo(() => {
    // Plain text: blend with app theme (dark text on light bg, light text on dark bg)
    // HTML emails: always render on a light background since senders design for white/light
    const plainTextDark = isDark && isPlainText;
    const htmlDark = isDark && !isPlainText;
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${plainTextDark ? "#e5e7eb" : "#1f2937"};
      background: ${htmlDark ? "#f8f9fa" : "transparent"};
      word-wrap: break-word;
      overflow-wrap: break-word;
      overflow: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${plainTextDark ? "#60a5fa" : "#3b82f6"}; }
    blockquote {
      border-left: 3px solid ${plainTextDark ? "#4b5563" : "#d1d5db"};
      margin: 8px 0;
      padding: 4px 12px;
      color: ${plainTextDark ? "#9ca3af" : "#6b7280"};
    }
    pre { overflow-x: auto; }
    table { max-width: 100%; }
  </style>
</head>
<body>${bodyHtml}<script src="/emailFrame.js"></script></body>
</html>`;
  }, [bodyHtml, isDark, isPlainText]);

  // The frame cannot read the store, so it is told the zoom whenever it changes
  // and whenever a fresh document has loaded.
  const sendZoom = useCallback(() => {
    // "*" because the frame has an opaque origin; the message carries only a number.
    iframeRef.current?.contentWindow?.postMessage({ type: "maish:zoom", zoom: mailZoom }, "*");
  }, [mailZoom]);
  useEffect(sendZoom, [sendZoom]);

  // Height reports and link clicks arrive from the frame as messages
  useLayoutEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;

      const data = event.data as { type?: unknown; url?: unknown; height?: unknown };
      if (!data || typeof data !== "object") return;

      if (data.type === "maish:height" && typeof data.height === "number") {
        iframe.style.height = data.height + "px";
        return;
      }

      // Wheel events do not leave the frame, so the frame reports them and they
      // are replayed on the iframe element, where an ancestor's swipe gesture
      // (`useSwipeGesture`) sees them like any other wheel event.
      if (data.type === "maish:wheel") {
        const { deltaX, deltaY, deltaMode, ctrlKey } = data as Record<string, unknown>;
        if (typeof deltaX !== "number" || typeof deltaY !== "number") return;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
        iframe.dispatchEvent(new WheelEvent("wheel", {
          deltaX,
          deltaY,
          deltaMode: deltaMode === 1 ? 1 : 0,
          ctrlKey: ctrlKey === true,
          bubbles: true,
          cancelable: true,
        }));
        return;
      }

      // Keys typed inside the frame: only the zoom keys are replayed, on the
      // iframe, so they bubble to the window like a key typed outside the frame.
      if (data.type === "maish:key") {
        const { key, ctrlKey, metaKey } = data as Record<string, unknown>;
        if (typeof key !== "string") return;
        const init = { key, ctrlKey: ctrlKey === true, metaKey: metaKey === true, altKey: false };
        if (!mailZoomKey(init)) return;
        iframe.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
        return;
      }

      // Same for the side buttons of a mouse: the app listens for them on the document.
      if (data.type === "maish:mouse") {
        const { button } = data as Record<string, unknown>;
        if (button !== 3 && button !== 4) return;
        iframe.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true, cancelable: true }));
        return;
      }

      if (data.type === "maish:link" && typeof data.url === "string") {
        if (!isOpenableUrl(data.url)) return;

        // A flagged link goes through the confirmation dialog first. The dialog
        // shows the URL that will actually open, not the raw href the scan read.
        const analysis = findLinkAnalysis(riskyLinks ?? [], data.url);
        if (analysis) {
          setPendingLink({ ...analysis, url: data.url });
          return;
        }

        openUrl(data.url).catch((err) => {
          console.error("Failed to open link:", err);
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [riskyLinks]);

  const handleConfirmLink = useCallback(() => {
    const url = pendingLink?.url;
    setPendingLink(null);
    if (!url) return;
    openUrl(url).catch((err) => {
      console.error("Failed to open link:", err);
    });
  }, [pendingLink]);

  const handleLoadImages = useCallback(() => {
    setOverrideShow(true);
  }, []);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      await addToAllowlist(accountId, senderAddress);
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  return (
    <div>
      {blocked && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-bg-secondary rounded-md border border-border-primary">
          <ImageOff size={14} className="text-text-tertiary shrink-0" />
          <span className="text-text-secondary flex-1 min-w-0">
            Images hidden to protect your privacy.
          </span>
          <button
            onClick={handleLoadImages}
            className="h-6 px-2 rounded-md font-medium text-text-primary border border-border-primary bg-bg-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="h-6 px-2 rounded-md font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={frameDoc}
        onLoad={sendZoom}
        className={`w-full border-0 ${isDark && !isPlainText ? "rounded-md" : ""}`}
        style={{ overflow: "hidden" }}
        title="Email content"
      />
      {pendingLink && (
        <LinkConfirmDialog
          linkAnalysis={pendingLink}
          onCancel={() => setPendingLink(null)}
          onConfirm={handleConfirmLink}
        />
      )}
    </div>
  );
}

