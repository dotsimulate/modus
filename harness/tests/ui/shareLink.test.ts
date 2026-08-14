/**
 * Sharing a link out of Modus.
 *
 * A home-screen web app on iOS has no address bar and no tabs, so the existing
 * "open in browser" button has nowhere to open and no way to hand the URL back
 * to the user. These cover the two things that make a share/copy affordance
 * actually work: the URL must be absolute (a root-relative path means nothing
 * once it leaves the document) and the outcome must be reported (a silent
 * clipboard write is indistinguishable from a failure).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configureBackendTarget, shareableBackendUrl } from "../../ui/src/backendTarget";
import { shareLink } from "../../ui/src/components/FileChanges";

afterEach(() => {
  configureBackendTarget({ pageOrigin: "http://localhost:5173" });
});

describe("shareableBackendUrl", () => {
  test("absolutizes a same-origin path against the page origin", () => {
    // apiBase is "" in browser mode, so backendUrl() alone yields a bare path —
    // correct for fetching, useless once pasted anywhere else.
    configureBackendTarget({ pageOrigin: "https://box.tailnet.ts.net" });
    expect(shareableBackendUrl("/api/file/raw?path=x", "https://box.tailnet.ts.net"))
      .toBe("https://box.tailnet.ts.net/api/file/raw?path=x");
  });

  test("leaves an already-absolute backend URL alone", () => {
    configureBackendTarget({ pageOrigin: "http://tauri.localhost", envUrl: "http://127.0.0.1:4317" });
    expect(shareableBackendUrl("/api/file/raw?path=x", "http://tauri.localhost"))
      .toBe("http://127.0.0.1:4317/api/file/raw?path=x");
  });

  test("does not double up slashes when the origin has a trailing one", () => {
    configureBackendTarget({ pageOrigin: "https://box.ts.net" });
    expect(shareableBackendUrl("/api/file/raw", "https://box.ts.net/"))
      .toBe("https://box.ts.net/api/file/raw");
  });

  test("returns the relative path rather than inventing a host", () => {
    // A confidently wrong absolute URL is worse than an obviously incomplete one.
    configureBackendTarget({ pageOrigin: "https://box.ts.net" });
    expect(shareableBackendUrl("/api/file/raw", "")).toBe("/api/file/raw");
  });

  test("normalizes a path given without a leading slash", () => {
    configureBackendTarget({ pageOrigin: "https://box.ts.net" });
    expect(shareableBackendUrl("api/file/raw", "https://box.ts.net"))
      .toBe("https://box.ts.net/api/file/raw");
  });
});

describe("shareLink", () => {
  test("prefers the native share sheet when the platform has one", async () => {
    const seen: unknown[] = [];
    const result = await shareLink("https://x/y", "report.html", {
      share: async (data) => { seen.push(data); },
      clipboard: { writeText: async () => { throw new Error("must not be reached"); } },
    });
    expect(result).toBe("shared");
    expect(seen).toEqual([{ title: "report.html", url: "https://x/y" }]);
  });

  test("falls back to the clipboard where there is no share sheet", async () => {
    let copied = "";
    const result = await shareLink("https://x/y", "t", {
      clipboard: { writeText: async (text) => { copied = text; } },
    });
    expect(result).toBe("copied");
    expect(copied).toBe("https://x/y");
  });

  test("a cancelled share sheet is respected, not overridden by a silent copy", async () => {
    // The user closing the sheet means no. Writing to the clipboard anyway would
    // take an action they just declined.
    let copied = false;
    const result = await shareLink("https://x/y", "t", {
      share: async () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; },
      clipboard: { writeText: async () => { copied = true; } },
    });
    expect(result).toBe("failed");
    expect(copied).toBe(false);
  });

  test("a share sheet that errors for another reason still falls back to copying", async () => {
    let copied = false;
    const result = await shareLink("https://x/y", "t", {
      share: async () => { throw new Error("NotAllowedError-ish"); },
      clipboard: { writeText: async () => { copied = true; } },
    });
    expect(result).toBe("copied");
    expect(copied).toBe(true);
  });

  test("reports failure when neither capability exists", async () => {
    expect(await shareLink("https://x/y", "t", {})).toBe("failed");
  });

  test("reports failure when the clipboard write throws", async () => {
    const result = await shareLink("https://x/y", "t", {
      clipboard: { writeText: async () => { throw new Error("denied"); } },
    });
    expect(result).toBe("failed");
  });
});
