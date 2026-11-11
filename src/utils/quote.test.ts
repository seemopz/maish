import { describe, it, expect } from "vitest";
import { buildQuote, buildForwardQuote } from "./quote";

const msg = {
  from_name: "<b>Eve</b>",
  from_address: "eve@example.com",
  date: 0,
  subject: "<i>s</i>",
  to_addresses: "a@example.com",
  body_html: null as string | null,
  body_text: "<img src=https://t.example/p.gif>" as string | null,
};

function images(html: string) {
  return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("img")]
    .map((img) => img.getAttribute("src"));
}

describe.each([
  ["buildQuote", buildQuote],
  ["buildForwardQuote", buildForwardQuote],
])("%s", (_, build) => {
  it("escapes a plain-text body and the sender's name", () => {
    const html = build(msg, true);
    expect(images(html)).toEqual([]);
    expect(html).not.toContain("<b>");
  });

  it("sanitises an html body", () => {
    const html = build({ ...msg, body_html: '<p onclick="x()">hi</p><script>x()</script>' }, true);
    expect(html).toContain("<p>hi</p>");
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
  });

  it("blocks remote images unless they are allowed", () => {
    const body_html = '<img src="https://t.example/p.gif">';
    expect(images(build({ ...msg, body_html }, false))).toEqual([""]);
    expect(images(build({ ...msg, body_html }, true))).toEqual(["https://t.example/p.gif"]);
  });
});
