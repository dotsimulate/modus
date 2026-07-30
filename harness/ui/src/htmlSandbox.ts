/**
 * The sandbox policy for every in-app HTML preview frame.
 *
 * HTML previews render file content the user did not write — an agent's build
 * output, a downloaded report, a scraped page. Two failure modes bracket the
 * correct policy, and both were live in this tree:
 *
 * - `sandbox=""` blocks scripts entirely, so any HTML that draws itself with
 *   JavaScript previews as a blank page. That is the "HTML doesn't work in the
 *   app" complaint.
 * - `sandbox="allow-scripts allow-same-origin"` is worse than no sandbox at all
 *   for a `srcDoc` frame. A srcdoc document inherits the embedding origin, so
 *   those two tokens together let the framed page script the app: it can read
 *   `localStorage` — where the harness auth bearer token lives — reach
 *   `parent.document`, and call authenticated routes as the user. The pair is
 *   explicitly called out as a sandbox escape in the HTML spec.
 *
 * `allow-scripts` alone is the useful middle. Scripts run, so previews work,
 * but the frame gets an opaque origin and therefore no access to the app's
 * storage, cookies, or DOM.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

/**
 * Whether a sandbox attribute keeps a framed document out of the app's origin.
 *
 * Exists so the escape above cannot be reintroduced silently. There is no DOM
 * test environment in this package, so the policy is pinned as a value rather
 * than asserted against a rendered frame.
 */
export function isOriginIsolatedSandbox(policy: string): boolean {
  const tokens = new Set(
    String(policy ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  // Either token alone is safe. Only the combination grants scripted access to
  // the embedding origin.
  return !(tokens.has("allow-scripts") && tokens.has("allow-same-origin"));
}
