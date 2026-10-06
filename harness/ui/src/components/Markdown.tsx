import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "../syntax-highlight";
import { isValidElement, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useFileViewer } from "../providers/FileViewerContext";
import {
  MERMAID_RENDER_TIMEOUT_MS,
  limitMarkdownContent,
  markdownRehypePlugins,
  mermaidInputError,
  mermaidSecurityConfig,
  sanitizeMermaidSvg,
} from "../markdown-security";
import {
  buildLinkMenuItems,
  classifyLinkTarget,
  markdownUrlTransform,
  resolveMarkdownLinkTarget,
  type LinkMenuActions,
} from "../markdown-links";
import { BACKEND_TARGET } from "../backendTarget";
import { isTauriRuntime, openDesktopExternalUrl, openDesktopPath, revealDesktopPath } from "../desktopBridge";
import { nativePickerApplies } from "../native-picker";
import { useContextMenu } from "./ContextMenu";
import { PasteBlock } from "./PasteBlock";
import { rehypeWordReveal } from "../markdown-reveal";
import { openMarkdownNavigation } from "../markdown-navigation";
import { MarkdownImage, MarkdownImageContext } from "./MarkdownImage";

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

type MarkdownComponents = Components
  & Record<"pasted", ComponentType<{ children?: ReactNode }>>
  & Record<"reveal", ComponentType<{ children?: ReactNode; delay?: number }>>;

const markdownComponents: MarkdownComponents = {
  img: MarkdownImage,
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
  reveal({ children, delay }: { children?: ReactNode; delay?: number }) {
    return (
      <span className="markdown-word-reveal" style={{ animationDelay: `${Number(delay) || 0}ms` }}>
        {children}
      </span>
    );
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

    const html = highlightCode(raw, lang);

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

export const Markdown = memo(function Markdown({
  content,
  sourceFile,
  cwd,
  revealText = false,
}: {
  content: string;
  sourceFile?: string;
  cwd?: string | null;
  revealText?: boolean;
}) {
  const { openFile } = useFileViewer();
  const { open: openContextMenu, portal: contextMenuPortal } = useContextMenu();
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bounded = limitMarkdownContent(content);
  const imageContext = useMemo(() => ({ sourceFile, cwd }), [sourceFile, cwd]);
  const rehypePlugins = useMemo(
    () => revealText ? [...markdownRehypePlugins, rehypeWordReveal] : markdownRehypePlugins,
    [revealText],
  );

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
    return href ? resolveMarkdownLinkTarget(href, sourceFile) : null;
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = targetOf(e);
    if (!target) return;
    if (target.kind === "navigation") {
      e.preventDefault();
      openMarkdownNavigation(target.target);
      return;
    }
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
      <MarkdownImageContext.Provider value={imageContext}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents}
          urlTransform={markdownUrlTransform}
        >
          {bounded.content}
        </ReactMarkdown>
      </MarkdownImageContext.Provider>
      {linkError && <div className="markdown-link-error" role="status">{linkError}</div>}
      {contextMenuPortal}
    </div>
  );
});
