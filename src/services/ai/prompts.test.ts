import { describe, it, expect } from "vitest";
import {
  AUTO_DRAFT_REPLY_PROMPT,
  CATEGORIZE_PROMPT,
  COMPOSE_PROMPT,
  FORMALIZE_PROMPT,
  IMPROVE_PROMPT,
  REPLY_PROMPT,
  SHORTEN_PROMPT,
  SMART_LABEL_PROMPT,
  SMART_REPLY_PROMPT,
  parseSummaryLanguage,
  withSummaryLanguage,
} from "./prompts";

describe("reply language", () => {
  it.each([
    ["reply", REPLY_PROMPT],
    ["smart reply", SMART_REPLY_PROMPT],
    ["auto draft", AUTO_DRAFT_REPLY_PROMPT],
  ])("tells the %s prompt to answer in the language of the mail", (_name, prompt) => {
    expect(prompt).toContain("same language as the most recent message in the email thread");
  });

  it.each([IMPROVE_PROMPT, SHORTEN_PROMPT, FORMALIZE_PROMPT])("keeps a rewrite in its language", (prompt) => {
    expect(prompt).toContain("Do not translate it.");
  });

  it("writes a composed mail in the language of the instructions", () => {
    expect(COMPOSE_PROMPT).toContain("in the language of the instructions");
  });

  it("leaves machine-readable prompts without a language rule", () => {
    expect(CATEGORIZE_PROMPT).not.toContain("language");
    expect(SMART_LABEL_PROMPT).not.toContain("language");
  });
});

describe("parseSummaryLanguage", () => {
  it("defaults to German when unset or unknown", () => {
    expect(parseSummaryLanguage(null)).toBe("de");
    expect(parseSummaryLanguage(undefined)).toBe("de");
    expect(parseSummaryLanguage("klingon")).toBe("de");
    expect(parseSummaryLanguage("toString")).toBe("de");
  });

  it("accepts the mail language and the listed languages", () => {
    expect(parseSummaryLanguage("email")).toBe("email");
    expect(parseSummaryLanguage("en")).toBe("en");
    expect(parseSummaryLanguage("fr")).toBe("fr");
  });
});

describe("withSummaryLanguage", () => {
  it("names a fixed language", () => {
    const prompt = withSummaryLanguage("Summarize.", "de");
    expect(prompt).toMatch(/^Summarize\.\n\n/);
    expect(prompt).toContain("in German, even if the source text is in another language");
  });

  it("follows the source text for the mail-language option", () => {
    expect(withSummaryLanguage("p", "email")).toContain("in the same language as the emails");
    expect(withSummaryLanguage("p", "email", "the user's question")).toContain(
      "in the same language as the user's question",
    );
  });

  it("keeps JSON keys and fixed values untranslated", () => {
    expect(withSummaryLanguage("p", "en")).toContain("JSON keys and fixed values");
  });
});
