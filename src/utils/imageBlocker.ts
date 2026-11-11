/**
 * Utility functions for blocking remote images in email HTML.
 * Preserves data: and cid: URIs, only blocks remote images.
 *
 * A protocol-relative "//host/path" counts as remote: the frame's base URL
 * supplies the scheme, so the markup alone does not say which one it will be.
 */

/**
 * Goes into the <head> of a document that shows mail while images are blocked.
 * The app policy allows `img-src https:`, so without this whatever
 * stripRemoteImages() misses would load. Inline cid: parts arrive as data: URIs.
 */
export const REMOTE_IMAGE_BLOCK = '<meta http-equiv="Content-Security-Policy" content="img-src data:">';

/**
 * Strip remote images from HTML by moving src to data-blocked-src.
 * Also strips remote url() references in inline styles.
 *
 * Not a complete barrier: the message frame and the print view add an
 * `img-src` policy on top. The composer has none, so the <img> rule must hold.
 */
export function stripRemoteImages(html: string): string {
  // Parsed, not matched as text: a serialised attribute value may hold ">", and
  // browsers read "https:\host" and "ht<TAB>tps://" as remote URLs.
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  for (const img of template.content.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src") ?? "";
    if (/^(data|cid):/i.test(src.replace(/[\s\u0000-\u001f]/g, ""))) continue;
    img.setAttribute("data-blocked-src", src);
    img.setAttribute("src", "");
    changed = true;
  }

  for (const el of template.content.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") ?? "";
    const stripped = style.replace(/url\(\s*(["']?)((?:https?:)?\/\/[^)"']*)\1\s*\)/gi, "url($1$1)");
    if (stripped === style) continue;
    el.setAttribute("style", stripped);
    changed = true;
  }

  return changed ? template.innerHTML : html;
}

/**
 * Check if an HTML string contains any blocked images.
 */
export function hasBlockedImages(html: string): boolean {
  return /data-blocked-src\s*=\s*["'](?:https?:)?\/\//i.test(html);
}
