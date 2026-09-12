import { describe, expect, test } from "bun:test";
import { escapeEverythingQuery } from "../file-search";

describe("escapeEverythingQuery", () => {
  test("leaves an ordinary query untouched", () => {
    expect(escapeEverythingQuery("session provider")).toBe("session provider");
    expect(escapeEverythingQuery("ext:ts widget")).toBe("ext:ts widget");
    expect(escapeEverythingQuery('"a phrase" ext:ts')).toBe('"a phrase" ext:ts');
  });

  // es.exe reads its final positional argument as a switch when it starts with a
  // dash, and some of its switches write. Verified against ES 1.1.0.30: a bare
  // `-zzz` exits 6 "Unknown switch"; the same token quoted searches normally.
  test("quotes a leading token that would be read as a switch", () => {
    expect(escapeEverythingQuery("-clear-settings")).toBe('"-clear-settings"');
    expect(escapeEverythingQuery("-save-db")).toBe('"-save-db"');
    expect(escapeEverythingQuery("-export-csv out.csv")).toBe('"-export-csv" out.csv');
  });

  test("quotes only the leading token, so the rest of the query still means what was typed", () => {
    expect(escapeEverythingQuery("-foo bar baz")).toBe('"-foo" bar baz');
    // Whitespace after the head is preserved verbatim rather than collapsed,
    // which keeps any phrase later in the query intact.
    expect(escapeEverythingQuery('-foo  "two  words"')).toBe('"-foo"  "two  words"');
  });

  // Only the first token can become a switch: the whole query travels as one
  // argv element and es.exe never re-splits it.
  test("a dash anywhere but the front is an ordinary search term", () => {
    expect(escapeEverythingQuery("probe -clear-settings")).toBe("probe -clear-settings");
    expect(escapeEverythingQuery("well-known")).toBe("well-known");
  });

  test("a quote inside the escaped token cannot close it early", () => {
    expect(escapeEverythingQuery('-fo"o')).toBe('"-foo"');
  });

  test("an empty query is left alone", () => {
    expect(escapeEverythingQuery("")).toBe("");
  });
});
