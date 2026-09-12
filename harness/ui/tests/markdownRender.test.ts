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
  const url = "modus://session/12345678-1234-1234-1234-123456789abc";
  it("preserves every supported Markdown and HTML link spelling", () => {
    for (const content of [
      url, `[${url}](${url})`, `[session](${url})`, `<${url}>`,
      `[session][ref]\n\n[ref]: ${url}`, `[session](${url} "title")`,
      `<a href="${url}">session</a>`, `- [session](${url})`,
      `| Session |\n| --- |\n| [session](${url}) |`, `**[session](${url})**`,
      `See (${url}).`, `[session](${url.replace("modus:", "MODUS:")})`,
    ]) expect(render(content)).toContain(`href="${url}"`);
  });

  it("does not linkify code, pasted blocks, or nest existing anchors", () => {
    for (const content of [`\`${url}\``, `\`\`\`\n${url}\n\`\`\``, `<pasted>${url}</pasted>`]) {
      expect(render(content)).not.toContain("<a ");
    }
    expect(render(`[${url}](${url})`).match(/<a /g)).toHaveLength(1);
  });

  it("strips unsupported Modus operations and never permits a Modus image source", () => {
    expect(render("[run](modus://move/run)")).not.toContain('href="modus:');
    expect(render(`![image](${url})`)).not.toContain('src="modus:');
  });

  it("normalizes protocol-relative web links", () => {
    expect(render("[web](//example.com/docs)")).toContain('href="https://example.com/docs"');
  });
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
