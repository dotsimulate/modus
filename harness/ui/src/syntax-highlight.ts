import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import { BoundedCache } from "../../bounded-cache";

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
import powershell from "highlight.js/lib/languages/powershell";

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
  powershell, ps1: powershell, pwsh: powershell,
};

for (const [name, lang] of Object.entries(langs)) {
  hljs.registerLanguage(name, lang);
}

// Register no-op languages for DSLs that appear in code fences but have no hljs grammar
const noop = () => ({ name: "noop", contains: [] });
for (const alias of ["toml", "graphql", "gql", "proto", "protobuf", "hcl", "terraform"]) {
  hljs.registerLanguage(alias, noop);
}

const highlights = new BoundedCache<string, string>(128, 4 * 1024 * 1024);

export function highlightCode(code: string, lang: string | null): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  const key = lang + "\0" + code;
  const cached = highlights.get(key);
  if (cached !== undefined) return cached;
  try {
    const html = hljs.highlight(code, { language: lang }).value;
    highlights.set(key, html, 2 * (key.length + html.length));
    return html;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
