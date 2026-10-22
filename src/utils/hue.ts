/**
 * Hues for the `tint-*` utilities in globals.css: twelve steps 30° apart. The
 * contrast of every step was checked against the tint tokens in both themes.
 */
export const HUES = Array.from({ length: 12 }, (_, i) => i * 30 + 15);

/** Fixed hues for the inbox categories, so a badge matches its sidebar entry. */
export const CATEGORY_HUES = new Map<string, number>([
  ["Updates", 255],
  ["Promotions", 135],
  ["Social", 315],
  ["Newsletters", 45],
]);

/** A category's hue, or undefined for Primary and anything else without a badge. */
export function categoryHue(category: string): number | undefined {
  // A Map, not an object literal: "constructor" or "toString" must not find an inherited member.
  return CATEGORY_HUES.get(category);
}

/**
 * A stable hue for a sender: FNV-1a over the lowercased address. Linear in the
 * length of the address only, so a thread row pays the same whatever the mailbox size.
 */
export function senderHue(address: string): number {
  let hash = 0x811c9dc5;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return HUES[(hash >>> 0) % HUES.length] as number;
}
