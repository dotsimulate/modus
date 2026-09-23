import { afterEach, describe, expect, test } from "bun:test";
import { backendUrl, configureBackendTarget } from "../../ui/src/backendTarget";

/**
 * Artifact URLs must resolve against the backend, not the document.
 *
 * Session artifacts are stored root-relative (`/api/sessions/<id>/artifacts/3`,
 * built in session-manager.attachArtifactToSession). That is correct only when
 * the document is served by the harness. The desktop shell is served from
 * tauri.localhost and talks to a backend on 127.0.0.1:<ephemeral>, so a relative
 * URL there is fetched from Tauri's asset server, which answers with the SPA's
 * index.html — surfacing as a broken image, or as "bad content-type: text/html"
 * from the audio player instead of playback.
 *
 * Third form of one underlying mistake: assuming the desktop shell is
 * same-origin with the backend. The other two were a CORS preflight on a custom
 * header, and X-Whisper-Url missing from allowHeaders.
 *
 * These drive the real backendUrl() through the real target resolver, so they
 * fail if either changes. The token-appending half for image/video element
 * sources lives in artifactSrc and is asserted through the same composition.
 * Audio fetches use an Authorization header (audioPlayer.test.ts).
 */

const DESKTOP = "http://127.0.0.1:51393";
const RELATIVE = "/api/sessions/ses-1/artifacts/3";

/** Image/video element source composition: absolute base, then credential. */
function withToken(url: string, token: string): string {
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  const absolute = backendUrl(url);
  if (!token) return absolute;
  const tp = `token=${token}`;
  return absolute.includes("?") ? `${absolute}&${tp}` : `${absolute}?${tp}`;
}

function useDesktopTarget() {
  configureBackendTarget({ search: `?modusTarget=${encodeURIComponent(DESKTOP)}&modusTargetMode=managed-local` });
}

function useBrowserTarget() {
  configureBackendTarget({ search: "" });
}

afterEach(useBrowserTarget);

describe("artifact URL resolution", () => {
  test("resolves against the backend origin under the desktop shell", () => {
    useDesktopTarget();
    expect(backendUrl(RELATIVE)).toBe(`${DESKTOP}${RELATIVE}`);
    expect(withToken(RELATIVE, "tok")).toBe(`${DESKTOP}${RELATIVE}?token=tok`);
  });

  test("stays relative for a same-origin browser, where apiBase is empty", () => {
    useBrowserTarget();
    expect(backendUrl(RELATIVE)).toBe(RELATIVE);
    expect(withToken(RELATIVE, "tok")).toBe(`${RELATIVE}?token=tok`);
  });

  test("carries the token, because img and video tags cannot set headers", () => {
    // Which is why the artifact route is in allowsQueryCredential server-side.
    useDesktopTarget();
    expect(withToken(RELATIVE, "tok")).toContain("token=tok");
    expect(withToken(RELATIVE, "")).not.toContain("token");
  });

  test("appends the token with & when the url already carries a query", () => {
    useDesktopTarget();
    expect(withToken(`${RELATIVE}?download=1`, "tok"))
      .toBe(`${DESKTOP}${RELATIVE}?download=1&token=tok`);
  });

  test("leaves an absolute url alone rather than doubling the origin", () => {
    useDesktopTarget();
    expect(backendUrl(`${DESKTOP}${RELATIVE}`)).toBe(`${DESKTOP}${RELATIVE}`);
  });

  test("never rewrites data: or blob: sources", () => {
    // The audio player swaps in a blob URL after fetching; re-resolving that
    // would corrupt the source it just created.
    useDesktopTarget();
    expect(withToken("blob:abc-123", "tok")).toBe("blob:abc-123");
    expect(withToken("data:audio/wav;base64,AAA", "tok")).toBe("data:audio/wav;base64,AAA");
  });

  test("normalizes a path that arrives without a leading slash", () => {
    useDesktopTarget();
    expect(backendUrl("api/pages")).toBe(`${DESKTOP}/api/pages`);
  });
});
