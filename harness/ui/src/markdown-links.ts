/**
 * What a link in rendered assistant markdown actually points at, and which
 * actions that permits.
 *
 * Two rules drive everything here.
 *
 * **Classify the authored href, never the resolved one.** `HTMLAnchorElement.href`
 * is resolved against the document, and the desktop document is served from
 * `tauri.localhost` — so an authored `/C:/build/app.exe` reads back as
 * `http://tauri.localhost/C:/build/app.exe`, which is neither the path the model
 * wrote nor a URL anything can open. Every function below takes the raw
 * `getAttribute("href")` string.
 *
 * **Hand the operating system only what we can name.** A link in a transcript is
 * model-authored text. Opening one is a real capability — the OS will launch
 * whatever handler is registered for a scheme — so the classifier allowlists
 * `http`/`https` and reports everything else as unsupported rather than guessing.
 * An unsupported target gets no Modus menu and no interception; it keeps whatever
 * the surrounding UI did before.
 *
 * The decisions are pure so they can be pinned without a DOM, which is the only
 * kind of UI test this tree has.
 */

import type { ContextMenuItem } from "./components/ContextMenu";

/** `C:\src` / `C:/src` — also the reason a scheme test cannot run first. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** `\\server\share` */
const UNC_PREFIX = /^\\\\/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** `path.ts:12` and `path.ts:12:34`, the form Modus and most models emit. */
const TRAILING_LINE = /:(\d+)(?::\d+)?$/;
/** `#L12`, `#L12-L18`, `#L12-18` — GitHub's form. */
const LINE_FRAGMENT = /^L(\d+)(?:-L?(\d+))?$/i;

const BARE_WEB_HOSTS: Array<{ pattern: RegExp; scheme: string }> = [
  { pattern: /^www\.[^/\s]+/i, scheme: "https" },
  { pattern: /^localhost(:\d+)?(\/|$)/i, scheme: "http" },
  { pattern: /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/, scheme: "http" },
  { pattern: /^\[[0-9A-Fa-f:]+\](:\d+)?(\/|$)/, scheme: "http" },
];

export type MarkdownLinkTarget =
  | { kind: "web"; url: string }
  | {
      kind: "local";
      path: string;
      /**
       * Whether the path names a location without needing a working directory.
       * Only an absolute path can be handed to the client's OS — a relative one
       * would resolve against the desktop process's own directory.
       */
      absolute: boolean;
      line?: number;
      endLine?: number;
    }
  | { kind: "unsupported" };

export function isAbsolutePath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || UNC_PREFIX.test(path) || path.startsWith("/");
}

/**
 * Split a local href into its path and any line reference.
 *
 * A fragment that is not a line reference is dropped, because `guide.md#install`
 * names a heading inside a file we can open rather than a file called
 * `guide.md#install`. That loses a Windows path containing a literal `#`; the
 * heading case is overwhelmingly more common and this matches what the renderer
 * has always done.
 */
export function splitLocalPath(href: string): { path: string; line?: number; endLine?: number } {
  const hash = href.lastIndexOf("#");
  if (hash > 0) {
    const match = href.slice(hash + 1).match(LINE_FRAGMENT);
    const path = href.slice(0, hash);
    if (!match) return { path };
    return { path, line: Number(match[1]), endLine: match[2] ? Number(match[2]) : undefined };
  }
  const trailing = href.match(TRAILING_LINE);
  if (trailing?.index !== undefined) {
    return { path: href.slice(0, trailing.index), line: Number(trailing[1]) };
  }
  return { path: href };
}

export function classifyLinkTarget(rawHref: string): MarkdownLinkTarget {
  const href = (rawHref ?? "").trim();
  if (!href) return { kind: "unsupported" };
  // An in-page anchor is the renderer's own business.
  if (href.startsWith("#")) return { kind: "unsupported" };

  if (WINDOWS_DRIVE.test(href) || UNC_PREFIX.test(href)) return localTarget(href);

  // Bare hosts are tested before schemes because `localhost:5180` satisfies the
  // scheme grammar, and reading `localhost` as a scheme would refuse the most
  // common link a local agent writes.
  for (const { pattern, scheme: implied } of BARE_WEB_HOSTS) {
    if (pattern.test(href)) return { kind: "web", url: `${implied}://${href}` };
  }

  const scheme = href.match(SCHEME)?.[1]?.toLowerCase();
  if (scheme) {
    // `mailto:`, `tel:`, `file:`, `modus:` and anything else deliberately fall
    // through unclaimed rather than being forwarded to a registered handler.
    return scheme === "http" || scheme === "https"
      ? { kind: "web", url: href }
      : { kind: "unsupported" };
  }

  if (
    href.startsWith("/")
    || href.startsWith("~/")
    || href.includes("/")
    || href.includes("\\")
  ) {
    return localTarget(href);
  }

  // A bare dotted token: `notes.md` is a file, `example.com` is a host, and
  // nothing in the href distinguishes them. Treated as a file, which is both
  // the long-standing behavior and the far more common case in a transcript.
  const { path } = splitLocalPath(href);
  if (/\.[A-Za-z0-9]{1,8}$/.test(path)) return localTarget(href);

  return { kind: "unsupported" };
}

function localTarget(href: string): MarkdownLinkTarget {
  const { path, line, endLine } = splitLocalPath(href);
  return { kind: "local", path, absolute: isAbsolutePath(path), line, endLine };
}

/**
 * What the platform calls the thing that shows a file in its folder.
 *
 * Takes the user-agent string rather than reading it, so the mapping is
 * testable and so a future macOS build does not offer to reveal something in
 * "File Explorer".
 */
export function fileManagerName(userAgent: string): string {
  if (/windows/i.test(userAgent)) return "File Explorer";
  if (/mac os|macintosh/i.test(userAgent)) return "Finder";
  return "file manager";
}

export type LinkMenuCapabilities = {
  /**
   * The client can reach the OS *and* its filesystem is the one the linked path
   * refers to. False for a browser tab, and false for a desktop window driving a
   * remote backend — there the path exists on the harness host, not here.
   */
  nativeFileActions: boolean;
  /** Used only to name the file manager. */
  userAgent: string;
};

export type LinkMenuActions = {
  openInEditor: (path: string, line?: number, endLine?: number) => void;
  revealPath: (path: string) => void;
  openPath: (path: string) => void;
  openExternal: (url: string) => void;
  copy: (text: string) => void;
};

/**
 * Build the menu for a link, or return an empty list to decline it.
 *
 * An empty list is meaningful: the caller must then leave the event alone so the
 * message-level selection menu still works.
 *
 * Both native path actions are correct for a file *and* a directory, which is
 * why no file-vs-directory guess appears here. Revealing selects the item in its
 * parent either way; opening hands it to the default handler, which for a
 * directory is the file manager. Answering "is this a directory" would need a
 * round trip the menu cannot wait for.
 */
export function buildLinkMenuItems(
  target: MarkdownLinkTarget,
  caps: LinkMenuCapabilities,
  actions: LinkMenuActions,
): ContextMenuItem[] {
  if (target.kind === "web") {
    // Both are reachable in a browser too — `openExternal` falls back to a new
    // tab there — so neither is gated on the client being a desktop window.
    return [
      { kind: "action", label: "Open in browser", onClick: () => actions.openExternal(target.url) },
      { kind: "separator" },
      { kind: "action", label: "Copy link", onClick: () => actions.copy(target.url) },
    ];
  }

  if (target.kind !== "local") return [];

  const items: ContextMenuItem[] = [
    {
      kind: "action",
      label: "Open in editor",
      onClick: () => actions.openInEditor(target.path, target.line, target.endLine),
    },
  ];

  if (caps.nativeFileActions && target.absolute) {
    items.push({ kind: "separator" });
    items.push({
      kind: "action",
      label: `Reveal in ${fileManagerName(caps.userAgent)}`,
      onClick: () => actions.revealPath(target.path),
    });
    items.push({
      kind: "action",
      label: "Open with default app",
      onClick: () => actions.openPath(target.path),
    });
  }

  items.push({ kind: "separator" });
  items.push({ kind: "action", label: "Copy path", onClick: () => actions.copy(target.path) });
  return items;
}
