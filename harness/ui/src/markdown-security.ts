import DOMPurify from "dompurify";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as ReactMarkdownOptions } from "react-markdown";

export const MAX_MARKDOWN_CHARS = 500_000;
export const MAX_MERMAID_CHARS = 50_000;
export const MAX_MERMAID_EDGES = 1_000;
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;

export const mermaidSecurityConfig = {
  securityLevel: "strict" as const,
  maxTextSize: MAX_MERMAID_CHARS,
  maxEdges: MAX_MERMAID_EDGES,
  htmlLabels: false,
};

// rehype-sanitize sees `D:/...` as protocol `D` and removes the href before
// React Markdown's later URL transform can classify it as a local path. Permit
// one-letter candidates through this first layer; markdownUrlTransform still
// rejects anything that is not actually `[A-Za-z]:[/\\]...`, and keeps every
// other scheme behind React Markdown's default sanitizer.
const windowsDriveProtocolCandidates = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"];

export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "pasted"],
  attributes: {
    ...defaultSchema.attributes,
    pasted: [],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), ...windowsDriveProtocolCandidates],
  },
};

export const markdownRehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
];

export function limitMarkdownContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_MARKDOWN_CHARS) return { content, truncated: false };
  return {
    content: `${content.slice(0, MAX_MARKDOWN_CHARS)}\n\n> Content truncated at ${MAX_MARKDOWN_CHARS.toLocaleString()} characters for safe rendering.`,
    truncated: true,
  };
}

type SvgSanitizer = (svg: string) => string;

export function assertSafeMermaidSvg(svg: string): void {
  if (!/<svg(?:\s|>)/i.test(svg)) throw new Error("Diagram output did not contain an SVG root");
  if (/<(?:script|foreignObject)(?:\s|>)/i.test(svg)) throw new Error("Diagram output contained active markup");
  if (/\son[a-z]+\s*=/i.test(svg)) throw new Error("Diagram output contained an event handler");
  if (/(?:href|xlink:href)\s*=\s*["']?\s*(?:javascript:|data:text\/html)/i.test(svg)) {
    throw new Error("Diagram output contained an active URL");
  }
}

export function sanitizeMermaidSvg(
  svg: string,
  sanitize: SvgSanitizer = (value) => DOMPurify.sanitize(value, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script"],
  }),
): string {
  const sanitized = sanitize(svg);
  assertSafeMermaidSvg(sanitized);
  return sanitized;
}

export function mermaidInputError(code: string): string | null {
  return code.length > MAX_MERMAID_CHARS
    ? `Diagram exceeds the ${MAX_MERMAID_CHARS.toLocaleString()} character rendering limit`
    : null;
}
