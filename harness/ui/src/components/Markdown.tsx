import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import hljs from "highlight.js/lib/core";
import { memo, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useFileViewer } from "../providers/FileViewerContext";
import { PasteBlock } from "./PasteBlock";

// Register languages — core set for dev/AI chat
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import json from "highlight.js/lib/languages/json";
import cssLang from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdownLang from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import ruby from "highlight.js/lib/languages/ruby";

const langs: Record<string, any> = {
  javascript, js: javascript, jsx: javascript,
  typescript, ts: typescript, tsx: typescript,
  python, py: python,
  bash, sh: bash, zsh: bash, shell,
  json, jsonc: json,
  css: cssLang, html: xml, xml,
  rust, rs: rust,
  go, golang: go,
  sql,
  yaml, yml: yaml,
  markdown: markdownLang, md: markdownLang,
  diff,
  c, cpp, "c++": cpp,
  java, ruby, rb: ruby,
};

for (const [name, lang] of Object.entries(langs)) {
  hljs.registerLanguage(name, lang);
}

// Register no-op languages for DSLs that appear in code fences but have no hljs grammar
const noop = () => ({ name: "noop", contains: [] });
for (const alias of ["toml", "graphql", "gql", "proto", "protobuf", "hcl", "terraform"]) {
  hljs.registerLanguage(alias, noop);
}

// Mermaid — lazy loaded (71MB package, only needed for mermaid code fences)
let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;

function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: {
          darkMode: true,
          background: "#000000",
          primaryColor: "#1a1a1a",
          primaryTextColor: "#e0e0e0",
          primaryBorderColor: "#333333",
          secondaryColor: "#111111",
          secondaryTextColor: "#bbbbbb",
          secondaryBorderColor: "#333333",
          tertiaryColor: "#0a0a0a",
          lineColor: "#555555",
          textColor: "#e0e0e0",
          mainBkg: "#111111",
          nodeBorder: "#333333",
          clusterBkg: "#0a0a0a",
          clusterBorder: "#1e1e1e",
          titleColor: "#e0e0e0",
          edgeLabelBackground: "#0a0a0a",
          nodeTextColor: "#e0e0e0",
        },
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 13,
      });
      return mod.default;
    });
  }
  return mermaidReady;
}

function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "_");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMermaid().then(async (m) => {
      try {
        const { svg } = await m.render(`mermaid${id}`, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Diagram render failed");
      }
    }).catch((e: any) => {
      if (!cancelled) setError(e?.message || "Failed to load mermaid");
    });
    return () => { cancelled = true; };
  }, [code, id]);

  if (error) {
    return (
      <div className="code-block">
        <div className="code-block-header">
          <span className="code-block-lang">mermaid</span>
        </div>
        <pre><code>{code}</code></pre>
      </div>
    );
  }

  return <div className="mermaid-diagram" ref={ref} />;
}

function highlight(code: string, lang: string | null): string {
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="code-block-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Fallback for non-secure contexts
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeRaw];

function isLocalFilePath(href: string): boolean {
  if (!href) return false;
  // Absolute unix paths, home-dir paths, or relative paths without a protocol
  if (/^https?:\/\//i.test(href)) return false;
  if (/^mailto:/i.test(href)) return false;
  if (href.startsWith("/") || href.startsWith("~/")) return true;
  // Looks like a file path (contains a slash or extension, no protocol)
  if (!href.includes("://") && (href.includes("/") || /\.\w{1,6}$/.test(href))) return true;
  return false;
}

function extractText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && node.props) return extractText(node.props.children);
  return "";
}

const markdownComponents: Record<string, any> = {
  pasted({ children }: { children?: React.ReactNode }) {
    const text = extractText(children).replace(/^\n+/, "").replace(/\n+$/, "");
    return <PasteBlock text={text} />;
  },
  pre({ children }: { children?: React.ReactNode }) {
    const child = children as ReactElement<any>;
    const props = child?.props;
    if (!props) return <pre>{children}</pre>;

    const className: string = props.className || "";
    const match = /language-(\w+)/.exec(className);
    const lang = match?.[1] || null;
    const raw = String(props.children ?? "").replace(/\n$/, "");

    if (lang === "mermaid") {
      return <MermaidDiagram code={raw} />;
    }

    const html = highlight(raw, lang);

    return (
      <div className="code-block">
        <div className="code-block-header">
          {lang && <span className="code-block-lang">{lang}</span>}
          <CopyButton text={raw} />
        </div>
        <pre>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const { openFile } = useFileViewer();

  function parseLineFragment(href: string): { path: string; line?: number; endLine?: number } {
    const [path, fragment] = href.split("#", 2);
    const match = fragment?.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (!match) return { path };
    return {
      path,
      line: Number(match[1]),
      endLine: match[2] ? Number(match[2]) : undefined,
    };
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || !isLocalFilePath(href)) return;
    e.preventDefault();
    const fileTarget = parseLineFragment(href);
    openFile(fileTarget.path, {
      line: fileTarget.line,
      endLine: fileTarget.endLine,
      highlight: fileTarget.line !== undefined,
      source: "markdown",
    });
  }

  return (
    <div onClick={handleClick}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
