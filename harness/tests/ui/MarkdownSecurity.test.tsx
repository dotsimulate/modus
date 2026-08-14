import { describe, expect, test } from "bun:test";
import { createElement } from "../../ui/node_modules/react";
import { renderToStaticMarkup } from "../../ui/node_modules/react-dom/server";
import ReactMarkdown from "../../ui/node_modules/react-markdown";
import {
  MAX_MARKDOWN_CHARS,
  MAX_MERMAID_CHARS,
  MAX_MERMAID_EDGES,
  assertSafeMermaidSvg,
  limitMarkdownContent,
  markdownRehypePlugins,
  mermaidInputError,
  mermaidSecurityConfig,
  sanitizeMermaidSvg,
} from "../../ui/src/markdown-security";

function render(content: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: markdownRehypePlugins }, content));
}

describe("hostile Markdown and Mermaid containment", () => {
  test("removes executable raw HTML while preserving ordinary formatting", () => {
    const html = render(`
# safe heading
<script>globalThis.pwned = true</script>
<img src="https://example.invalid/a.png" onerror="globalThis.pwned = true">
<iframe srcdoc="<script>globalThis.pwned = true</script>"></iframe>
<svg onload="globalThis.pwned = true"><script>globalThis.pwned = true</script></svg>
<a href="javascript:globalThis.pwned=true" onclick="globalThis.pwned=true">bad</a>
<strong>kept</strong>
`);

    expect(html).toContain("safe heading");
    expect(html).toContain("<strong>kept</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
  });

  test("allows the custom pasted block but strips attributes", () => {
    const html = render('<pasted onclick="alert(1)">operator text</pasted>');
    expect(html).toContain("<pasted>operator text</pasted>");
    expect(html).not.toContain("onclick");
  });

  test("bounds Markdown parser input with an explicit notice", () => {
    const result = limitMarkdownContent("x".repeat(MAX_MARKDOWN_CHARS + 100));
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(MAX_MARKDOWN_CHARS + 200);
    expect(result.content).toContain("Content truncated");
  });

  test("configures Mermaid for strict, non-HTML labels and bounded input", () => {
    expect(mermaidSecurityConfig.securityLevel).toBe("strict");
    expect(mermaidSecurityConfig.htmlLabels).toBe(false);
    expect(mermaidSecurityConfig.maxTextSize).toBe(MAX_MERMAID_CHARS);
    expect(mermaidSecurityConfig.maxEdges).toBe(MAX_MERMAID_EDGES);
    expect(mermaidInputError("x".repeat(MAX_MERMAID_CHARS))).toBeNull();
    expect(mermaidInputError("x".repeat(MAX_MERMAID_CHARS + 1))).toContain("rendering limit");
  });

  test("rejects active Mermaid SVG even if the primary sanitizer regresses", () => {
    const identity = (value: string) => value;
    expect(() => sanitizeMermaidSvg('<svg onload="alert(1)"></svg>', identity)).toThrow("event handler");
    expect(() => sanitizeMermaidSvg('<svg><foreignObject><script>alert(1)</script></foreignObject></svg>', identity)).toThrow("active markup");
    expect(() => sanitizeMermaidSvg('<svg><a href="javascript:alert(1)">x</a></svg>', identity)).toThrow("active URL");
    expect(() => assertSafeMermaidSvg('<svg><path d="M0 0L1 1"/></svg>')).not.toThrow();
  });
});
