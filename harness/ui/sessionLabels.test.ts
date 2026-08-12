/**
 * sessionDisplayText — the shared session-row label.
 *
 * The move-preamble cases are the point: sessions.last_prompt/preview are stored
 * truncated to 80 chars, so a move-launched session's stored text is entirely the
 * move's injected header with no closing tag and none of the user's own words.
 */

import { describe, expect, test } from "bun:test";
import { compactModelName, isEmptySession, sessionDisplayText } from "./src/utils/format";

describe("sessionDisplayText", () => {
  test("prefers a user-set title and never rewrites it", () => {
    expect(sessionDisplayText({ title: "my title", last_prompt: "ignored" })).toBe("my title");
    expect(sessionDisplayText({ title: "<!-- move:x --> literal" })).toBe("<!-- move:x --> literal");
  });

  test("falls back through last_prompt then preview", () => {
    expect(sessionDisplayText({ last_prompt: "the prompt", preview: "the preview" })).toBe("the prompt");
    expect(sessionDisplayText({ preview: "the preview" })).toBe("the preview");
    expect(sessionDisplayText({})).toBe("");
  });

  test("names the move when the stored text is a truncated preamble", () => {
    // Exactly what is in the database: an opener, no closer, 80 chars total.
    const stored = "<!-- move:modus-brain -->\nYou are inside the `modus-brain` move. You have intera";
    expect(sessionDisplayText({ last_prompt: stored })).toBe("modus-brain move");
  });

  test("does not put an injected token in the label", () => {
    // Shape only — a placeholder token, never a real one from a live database.
    const stored = "<!-- move:memory-pool -->\ntoken: EXAMPLE-TOKEN-VALUE\n## How to call ops\n\nUse the ";
    const label = sessionDisplayText({ last_prompt: stored });
    expect(label).toBe("memory-pool move");
    expect(label).not.toContain("EXAMPLE-TOKEN-VALUE");
  });

  test("keeps the user's text when a complete move block precedes it", () => {
    const stored = "<!-- move:chess -->\nboard state here\n<!-- /move:chess -->\n\nplay e4 please";
    expect(sessionDisplayText({ last_prompt: stored })).toBe("play e4 please");
  });

  test("names the move when a complete block leaves nothing behind", () => {
    const stored = "<!-- move:chess -->\nboard state\n<!-- /move:chess -->";
    expect(sessionDisplayText({ last_prompt: stored })).toBe("chess move");
  });

  test("leaves ordinary text alone, including unrelated html comments", () => {
    expect(sessionDisplayText({ last_prompt: "fix the parser" })).toBe("fix the parser");
    expect(sessionDisplayText({ last_prompt: "<!-- note --> fix it" })).toBe("<!-- note --> fix it");
  });
});

describe("isEmptySession", () => {
  test("is about presence of text, not whether it is a move preamble", () => {
    expect(isEmptySession({})).toBe(true);
    expect(isEmptySession({ preview: "<!-- move:x -->" })).toBe(false);
  });
});

describe("compactModelName", () => {
  test("strips date suffixes and vendor prefixes", () => {
    expect(compactModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(compactModelName("gemini-2-5-pro")).toBe("2-5-pro");
    expect(compactModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});
