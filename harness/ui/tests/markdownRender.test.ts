import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownUrlTransform } from "../src/markdown-links";
import { markdownRehypePlugins } from "../src/markdown-security";

function render(content: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: markdownRehypePlugins,
    urlTransform: markdownUrlTransform,
    children: content,
  }));
}

describe("rendered markdown links", () => {
  it("carries a Windows drive href through both sanitizer layers", () => {
    expect(render("[report](D:/example/report.md:1)")).toContain(
      'href="D:/example/report.md:1"',
    );
  });

  it("still strips an active scheme from the rendered anchor", () => {
    const html = render("[bad](javascript:alert(1))");
    expect(html).toContain("<a>bad</a>");
    expect(html).not.toContain("href=");
  });
});
