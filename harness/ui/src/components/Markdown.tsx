import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import { memo, useState, type ReactElement } from "react";

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
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

const plugins = [remarkGfm];

const markdownComponents = {
  pre({ children }: { children: React.ReactNode }) {
    const child = children as ReactElement<any>;
    const props = child?.props;
    if (!props) return <pre>{children}</pre>;

    const className: string = props.className || "";
    const match = /language-(\w+)/.exec(className);
    const lang = match?.[1] || null;
    const raw = String(props.children ?? "").replace(/\n$/, "");
    const html = highlight(raw, lang);

    return (
      <div className="code-block">
        <div className="code-block-header">
          <span className="code-block-lang">{lang || "text"}</span>
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
  return (
    <ReactMarkdown remarkPlugins={plugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});
