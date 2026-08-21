import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import { isValidElement, memo, useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useFileViewer } from "../providers/FileViewerContext";
import {
  MERMAID_RENDER_TIMEOUT_MS,
  limitMarkdownContent,
  markdownRehypePlugins,
  mermaidInputError,
  mermaidSecurityConfig,
  sanitizeMermaidSvg,
} from "../markdown-security";
import { buildLinkMenuItems, classifyLinkTarget, type LinkMenuActions } from "../markdown-links";
import { BACKEND_TARGET } from "../backendTarget";
import { isTauriRuntime, openDesktopExternalUrl, openDesktopPath, revealDesktopPath } from "../desktopBridge";
import { nativePickerApplies } from "../native-picker";
import { useContextMenu } from "./ContextMenu";
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

const langs: Record<string, LanguageFn> = {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Diagram render timed out")), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        ...mermaidSecurityConfig,
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
  const inputError = mermaidInputError(code);

  useEffect(() => {
    let cancelled = false;
    if (ref.current) ref.current.replaceChildren();
    if (inputError) {
      return () => { cancelled = true; };
    }
    getMermaid().then(async (m) => {
      try {
        const { svg } = await withTimeout(
          m.render(`mermaid${id}`, code),
          MERMAID_RENDER_TIMEOUT_MS,
        );
        if (!cancelled && ref.current) {
          const sanitized = sanitizeMermaidSvg(svg);
          ref.current.innerHTML = sanitized;
          setError(null);
        }
      } catch (caught: unknown) {
        if (!cancelled) setError(caught instanceof Error && caught.message ? caught.message : "Diagram render failed");
      }
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error && caught.message ? caught.message : "Failed to load mermaid");
    });
    return () => { cancelled = true; };
  }, [code, id, inputError]);

  if (error || inputError) {
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

function extractText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

type MarkdownComponents = Components & Record<"pasted", ComponentType<{ children?: ReactNode }>>;

const markdownComponents: MarkdownComponents = {
  // Web links open a new tab rather than replacing the app. In a browser that
  // is what `target` does; in the desktop shell `handleClick` intercepts first
  // and routes to the system browser, because a Tauri webview would otherwise
  // navigate itself away from Modus with no way back.
  a({ href, title, children }: { href?: string; title?: string; children?: ReactNode }) {
    const isWeb = classifyLinkTarget(href ?? "").kind === "web";
    return isWeb ? (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener">{children}</a>
    ) : (
      <a href={href} title={title}>{children}</a>
    );
  },
  pasted({ children }: { children?: ReactNode }) {
    const text = extractText(children).replace(/^\n+/, "").replace(/\n+$/, "");
    return <PasteBlock text={text} />;
  },
  pre({ children }: { children?: ReactNode }) {
    const child = children as ReactElement<{ className?: string; children?: ReactNode }>;
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
  const { open: openContextMenu, portal: contextMenuPortal } = useContextMenu();
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bounded = limitMarkdownContent(content);

  useEffect(() => () => {
    if (linkErrorTimer.current) clearTimeout(linkErrorTimer.current);
  }, []);

  // The packaged desktop has no devtools, so a failed handoff has to say so on
  // screen or it is indistinguishable from a menu item that does nothing.
  const reportLinkFailure = useCallback((what: string) => (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    setLinkError(`${what}: ${detail}`);
    if (linkErrorTimer.current) clearTimeout(linkErrorTimer.current);
    linkErrorTimer.current = setTimeout(() => setLinkError(null), 5000);
  }, []);

  const openInEditor = useCallback((path: string, line?: number, endLine?: number) => {
    openFile(path, { line, endLine, highlight: line !== undefined, source: "markdown" });
  }, [openFile]);

  const openExternal = useCallback((url: string) => {
    if (isTauriRuntime()) {
      void openDesktopExternalUrl(url).catch(reportLinkFailure("Could not open link"));
      return;
    }
    window.open(url, "_blank", "noreferrer");
  }, [reportLinkFailure]);

  const linkActions: LinkMenuActions = {
    openInEditor,
    revealPath: (path) => void revealDesktopPath(path).catch(reportLinkFailure("Could not reveal path")),
    openPath: (path) => void openDesktopPath(path).catch(reportLinkFailure("Could not open path")),
    openExternal,
    copy: (text) => void navigator.clipboard.writeText(text).catch(reportLinkFailure("Could not copy")),
  };

  /**
   * Classify from the attribute, never from `link.href` — the resolved form is
   * what turns a local path into `http://tauri.localhost/C:/...`.
   */
  function targetOf(e: React.MouseEvent) {
    const link = (e.target as HTMLElement).closest("a");
    const href = link?.getAttribute("href");
    return href ? classifyLinkTarget(href) : null;
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = targetOf(e);
    if (!target) return;
    if (target.kind === "local") {
      e.preventDefault();
      openInEditor(target.path, target.line, target.endLine);
      return;
    }
    // In a browser the anchor's own `target="_blank"` is already correct; only
    // the desktop shell needs the navigation taken away from it.
    if (target.kind === "web" && isTauriRuntime()) {
      e.preventDefault();
      openExternal(target.url);
    }
  }

  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const target = targetOf(e);
    if (!target) return;
    const items = buildLinkMenuItems(target, {
      // Revealing acts on this machine's filesystem, so it is only meaningful
      // when the linked path is the same one the backend wrote.
      nativeFileActions: nativePickerApplies(isTauriRuntime(), BACKEND_TARGET.mode),
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    }, linkActions);
    // Declining leaves the event to bubble, so the message-level selection menu
    // still opens for a right-click that happened to land on an unclaimed link.
    if (items.length === 0) return;
    openContextMenu(e, items);
  }

  return (
    <div onClick={handleClick} onContextMenu={handleContextMenu}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
        {bounded.content}
      </ReactMarkdown>
      {linkError && <div className="markdown-link-error" role="status">{linkError}</div>}
      {contextMenuPortal}
    </div>
  );
});
