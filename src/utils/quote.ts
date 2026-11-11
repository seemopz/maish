import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { stripRemoteImages } from "@/utils/imageBlocker";

export interface QuotedMessage {
  from_name: string | null;
  from_address: string | null;
  date: string | number;
  subject: string | null;
  to_addresses: string | null;
  body_html: string | null;
  body_text: string | null;
}

// The composer renders the quote in the app webview, where the policy allows
// any https image, so remote images are stripped unless the sender is allowed.
function quotedBody(msg: QuotedMessage, allowRemoteImages: boolean): string {
  const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
  return allowRemoteImages ? body : stripRemoteImages(body);
}

export function buildQuote(msg: QuotedMessage, allowRemoteImages: boolean): string {
  const date = new Date(msg.date).toLocaleString();
  const from = msg.from_name
    ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
    : escapeHtml(msg.from_address ?? "Unknown");
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666">On ${date}, ${from} wrote:<br>${quotedBody(msg, allowRemoteImages)}</div>`;
}

export function buildForwardQuote(msg: QuotedMessage, allowRemoteImages: boolean): string {
  const date = new Date(msg.date).toLocaleString();
  return `<br><br>---------- Forwarded message ---------<br>From: ${escapeHtml(msg.from_name ?? "")} &lt;${escapeHtml(msg.from_address ?? "")}&gt;<br>Date: ${date}<br>Subject: ${escapeHtml(msg.subject ?? "")}<br>To: ${escapeHtml(msg.to_addresses ?? "")}<br><br>${quotedBody(msg, allowRemoteImages)}`;
}
