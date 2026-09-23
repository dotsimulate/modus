import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { resolveMarkdownImageTarget } from "../src/markdown-images";
import { markdownUrlTransform } from "../src/markdown-links";
import { markdownRehypePlugins } from "../src/markdown-security";
import { MarkdownImage } from "../src/components/MarkdownImage";

describe("Markdown images", () => {
  it("resolves backend paths, including leading-slash Windows paths and encoded names", () => {
    for (const src of ["D:/example/a%20b.png", "/D:/example/a%20b.png"]) {
      expect(resolveMarkdownImageTarget(src)).toEqual({ kind: "local", path: "D:/example/a b.png" });
    }
    expect(resolveMarkdownImageTarget("C:\\example\\plot.png")).toEqual({ kind: "local", path: "C:\\example\\plot.png" });
    expect(resolveMarkdownImageTarget("/tmp/plot.png")).toEqual({ kind: "local", path: "/tmp/plot.png" });
  });

  it("resolves relative images beside a preview file or in the owning session cwd", () => {
    expect(resolveMarkdownImageTarget("../images/plot.png", "D:/example/docs/readme.md", "D:/other"))
      .toEqual({ kind: "local", path: "D:/example/images/plot.png" });
    expect(resolveMarkdownImageTarget("./plot.png", undefined, "C:\\example"))
      .toEqual({ kind: "local", path: "C:/example/plot.png" });
  });

  it("preserves external and backend media URLs without treating them as files", () => {
    for (const src of ["https://example.com/a.png", "/api/git/raw/a.png?cwd=example"]) {
      expect(resolveMarkdownImageTarget(src)).toEqual({ kind: "web", url: src });
    }
    expect(resolveMarkdownImageTarget("//example.com/a.png"))
      .toEqual({ kind: "web", url: "https://example.com/a.png" });
  });

  function render(content: string): string {
    return renderToStaticMarkup(createElement(ReactMarkdown, {
      rehypePlugins: markdownRehypePlugins,
      urlTransform: markdownUrlTransform,
      components: { img: MarkdownImage },
      children: content,
    }));
  }

  it("carries local images through both sanitizers to ticketed rendering", () => {
    for (const content of [
      "![plot](D:/example/plot.png)",
      "![plot](C:\\example\\plot.png)",
      "![plot](/C:\\example\\plot.png)",
      "![plot](/D:/example/plot.png)",
      "![plot](<D:/example/a b.png>)",
      "![plot][image]\n\n[image]: D:/example/plot.png",
      '<img src="D:/example/plot.png" alt="plot" onerror="alert(1)">',
      "![plot](/tmp/plot.png)",
    ]) {
      const html = render(content);
      expect(html).toContain("Loading image: plot");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror");
    }
  });

  it("keeps unsafe schemes blocked and reports unavailable sources", () => {
    for (const src of ["javascript:alert(1)", "d:alert(1)", "data:text/html,bad", "modus://session/test", "file:///tmp/plot.png"]) {
      expect(render(`![plot](${src})`)).toContain("Image unavailable: plot");
      expect(render(`![plot](${src})`)).not.toContain("<img");
    }
    expect(render("![plot](https://example.com/plot.png)"))
      .toContain('<img src="https://example.com/plot.png" alt="plot"');
  });
});
