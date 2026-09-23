import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "../../ui/node_modules/react";
import { renderToStaticMarkup } from "../../ui/node_modules/react-dom/server";
import { getAboutInfo } from "../../about";
import { AboutPanelContent, docsPageHash, loadAboutDoc } from "../../ui/src/components/AboutPanel";
import AboutWidget from "../../ui/src/widgets/about.widget";
import type { WidgetProps } from "../../ui/src/widgets/types";

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}

describe("About help navigation", () => {
  test("the Documentation link uses the docs page route and keeps the selected profile", () => {
    expect(docsPageHash("#reader/home")).toBe("#reader/page:docs");
    expect(docsPageHash("#reader/chat/123e4567-e89b-12d3-a456-426614174000?x=1"))
      .toBe("#reader/page:docs");
    expect(docsPageHash("#page:profiles")).toBe("#page:docs");
    expect(docsPageHash("#123e4567-e89b-12d3-a456-426614174000")).toBe("#page:docs");
  });

  test("every shipped help topic renders a working button and docs is a link", () => {
    const info = getAboutInfo({ MODUS_DESKTOP_VERSION: "0.2.0" });
    const opened: string[] = [];
    const content = AboutPanelContent({
      info,
      docsHref: "#reader/page:docs",
      onOpenDoc: (id) => opened.push(id),
    });
    const html = renderToStaticMarkup(content);
    expect(html).toContain('href="#reader/page:docs"');
    expect(html).toContain(`href="${info.links.find((link) => link.label === "Source repository")?.href}"`);

    const buttons = elements(content).filter((element) => element.type === "button");
    expect(buttons).toHaveLength(info.topics.filter((topic) => topic.docId).length);
    for (const button of buttons) {
      (button.props as { onClick: () => void }).onClick();
    }
    expect(opened).toEqual(info.topics.map((topic) => topic.docId).filter(Boolean));
  });

  test("the dashboard widget uses the app's navigation callback", () => {
    const visited: string[] = [];
    const widget = AboutWidget({ onNavigate: (view) => visited.push(view) } as WidgetProps);
    const click = (widget.props as { onOpenDocs: (event: { preventDefault: () => void }) => void }).onOpenDocs;
    let prevented = false;
    click({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(visited).toEqual(["page:docs"]);
  });

  test("an About topic loads the same authenticated bundled docs API as the docs reader", async () => {
    const previousFetch = globalThis.fetch;
    const previousStorage = globalThis.localStorage;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.localStorage = { getItem: () => "", } as unknown as Storage;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "guide/intro", title: "Intro", content: "# Intro" }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const doc = await loadAboutDoc("guide/intro");
      expect(doc.content).toBe("# Intro");
      expect(requests[0]?.url).toEndWith("/api/docs/guide/intro");
      expect(requests[0]?.init?.headers).toHaveProperty("Content-Type", "application/json");
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.localStorage = previousStorage;
    }
  });
});
