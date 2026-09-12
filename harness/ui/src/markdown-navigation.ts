import type { DesktopDeepLinkTarget } from "./desktopBridge";
import { isSessionId } from "./sessionIds";

const LINK_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MARKDOWN_NAVIGATION_EVENT = "modus:markdown-navigation";

/** In-app aliases never go through an OS protocol handler or file preview. */
export function parseMarkdownNavigation(href: string): DesktopDeepLinkTarget | null {
  if (href.length > 512) return null;
  const match = href.match(/^(?:modus:(?:\/\/)?|\/{1,2})(session|page)\/([^?#]+)(?:[?#].*)?$/i);
  if (!match) return null;
  const [, kind, value] = match;
  if (kind.toLowerCase() === "session") {
    return isSessionId(value) ? { kind: "session", sessionId: value } : null;
  }
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => LINK_SLUG.test(part))
    ? { kind: "page", project: parts[0], slug: parts[1] }
    : null;
}

export function openMarkdownNavigation(target: DesktopDeepLinkTarget): void {
  window.dispatchEvent(new CustomEvent(MARKDOWN_NAVIGATION_EVENT, { detail: target }));
}

export function onMarkdownNavigation(handler: (target: DesktopDeepLinkTarget) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<DesktopDeepLinkTarget>).detail);
  window.addEventListener(MARKDOWN_NAVIGATION_EVENT, listener);
  return () => window.removeEventListener(MARKDOWN_NAVIGATION_EVENT, listener);
}

type HtmlNode = { type: string; tagName?: string; value?: string; children?: HtmlNode[]; properties?: Record<string, string> };

/** Linkify text nodes only: code, existing anchors, and pasted blocks stay literal. */
export function rehypeModusLinks() {
  return (tree: HtmlNode) => {
    function walk(node: HtmlNode) {
      if (node.tagName === "a" && node.properties?.href && parseMarkdownNavigation(node.properties.href)) {
        node.properties.href = node.properties.href.replace(/^modus:/i, "modus:");
      }
      if (["a", "code", "pre", "pasted"].includes(node.tagName ?? "") || !node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        const nodes: HtmlNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/\bmodus:(?:\/\/)?(?:session|page)\/[^\s<>"'`]+/gi)) {
          const href = match[0].replace(/[.,;:!?\)\]\}]+$/, "");
          if (!parseMarkdownNavigation(href)) continue;
          nodes.push({ type: "text", value: child.value.slice(offset, match.index) });
          nodes.push({ type: "element", tagName: "a", properties: { href: href.replace(/^modus:/i, "modus:") }, children: [{ type: "text", value: href }] });
          offset = match.index + href.length;
        }
        nodes.push({ type: "text", value: child.value.slice(offset) });
        return nodes;
      });
    }
    walk(tree);
  };
}
