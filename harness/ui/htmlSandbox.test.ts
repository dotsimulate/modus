import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HTML_PREVIEW_SANDBOX, isOriginIsolatedSandbox } from "./src/htmlSandbox";

// One component owns every script-enabled frame. Scanned as source because this
// package has no DOM test environment, so a rendered frame cannot be inspected.
const FRAME_OWNER = "src/components/SandboxedHtmlFrame.tsx";
const HTML_FRAME_SOURCES = [FRAME_OWNER];

function uiSourceFiles(): string[] {
  return readdirSync(join(import.meta.dir, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
    .map((entry) => join("src", entry));
}

function iframesIn(relativePath: string): string[] {
  const source = readFileSync(join(import.meta.dir, relativePath), "utf8");
  return source.match(/<iframe[\s\S]*?\/>/g) ?? [];
}

describe("html preview sandbox policy", () => {
  test("the shipped policy runs scripts without granting the app origin", () => {
    // Both halves matter. Without allow-scripts a JS-driven page previews blank;
    // with allow-same-origin alongside it, the frame can read the auth token out
    // of localStorage.
    expect(HTML_PREVIEW_SANDBOX).toContain("allow-scripts");
    expect(isOriginIsolatedSandbox(HTML_PREVIEW_SANDBOX)).toBe(true);
  });

  test("rejects the one token combination that escapes the sandbox", () => {
    expect(isOriginIsolatedSandbox("allow-scripts allow-same-origin")).toBe(false);
    expect(isOriginIsolatedSandbox("allow-same-origin allow-scripts")).toBe(false);
    // Order, casing and extra tokens must not smuggle it past the check.
    expect(isOriginIsolatedSandbox("allow-forms Allow-Scripts allow-same-origin")).toBe(false);
    expect(isOriginIsolatedSandbox("  allow-scripts   allow-same-origin  ")).toBe(false);
  });

  test("either token on its own is safe", () => {
    // allow-same-origin without scripts cannot act; allow-scripts without it
    // gets an opaque origin.
    expect(isOriginIsolatedSandbox("allow-scripts")).toBe(true);
    expect(isOriginIsolatedSandbox("allow-same-origin")).toBe(true);
    expect(isOriginIsolatedSandbox("")).toBe(true);
    expect(isOriginIsolatedSandbox("allow-scripts allow-forms allow-popups")).toBe(true);
  });
});

describe("html preview frames carry no credential", () => {
  // A frame that runs scripts can read its own document URL no matter what the
  // sandbox says. modus.previewUrl() appends the operator bearer token as a
  // query parameter, so a script-enabled frame pointed at one of those URLs
  // hands the token to the previewed file, which can beacon it out. srcDoc has
  // no URL, so there is nothing to read. Neither half of that is visible to the
  // typechecker and both renderers have already drifted once.
  test("every script-enabled html frame renders from srcDoc, never a src URL", () => {
    let checked = 0;
    for (const path of HTML_FRAME_SOURCES) {
      for (const frame of iframesIn(path)) {
        if (!frame.includes("HTML_PREVIEW_SANDBOX")) continue;
        checked += 1;
        expect(frame).toContain("srcDoc");
        expect(frame).not.toMatch(/\bsrc=/);
      }
    }
    // Fail if the scan matched nothing — a renamed constant or reformatted JSX
    // would otherwise make this test silently vacuous.
    expect(checked).toBe(1);
  });

  // The comment above records that these renderers "have already drifted once".
  // They drifted because each call site built its own frame. Now that one
  // component owns the policy, pin that: a second script-enabled frame anywhere
  // in the UI is the drift starting again.
  test("only the owning component applies the script-enabled sandbox", () => {
    const offenders = uiSourceFiles().filter((path) => {
      if (path.replace(/\\/g, "/") === FRAME_OWNER) return false;
      const source = readFileSync(join(import.meta.dir, path), "utf8");
      return /sandbox=\{\s*HTML_PREVIEW_SANDBOX\s*\}/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  test("no html renderer hardcodes the sandbox escape", () => {
    for (const path of HTML_FRAME_SOURCES) {
      const source = readFileSync(join(import.meta.dir, path), "utf8");
      // Comments in these files discuss the escape by name, so only reject it
      // where it would take effect: inside a sandbox attribute.
      expect(source).not.toMatch(/sandbox=["'][^"']*allow-same-origin/);
    }
  });
});
