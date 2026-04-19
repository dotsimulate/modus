import { prepare, layout, clearCache, type PreparedText, type LayoutResult } from "@chenglou/pretext";

const FONT_SANS = "'IBM Plex Sans', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";
const BASE_FONT_SIZE = 14;
const MESSAGE_LINE_HEIGHT_RATIO = 1.7;
const CODE_LINE_HEIGHT_RATIO = 1.5;

export type FontProfile = "message" | "code" | "meta" | "session-preview";

const fontProfiles: Record<FontProfile, { font: string; lineHeight: number }> = {
  message: {
    font: `${BASE_FONT_SIZE}px ${FONT_SANS}`,
    lineHeight: Math.round(BASE_FONT_SIZE * MESSAGE_LINE_HEIGHT_RATIO),
  },
  code: {
    font: `13px ${FONT_MONO}`,
    lineHeight: Math.round(13 * CODE_LINE_HEIGHT_RATIO),
  },
  meta: {
    font: `10px ${FONT_MONO}`,
    lineHeight: 16,
  },
  "session-preview": {
    font: `12px ${FONT_SANS}`,
    lineHeight: 18,
  },
};

export function getFontProfile(profile: FontProfile, fontScale = 1) {
  const base = fontProfiles[profile];
  if (fontScale === 1) return base;
  const size = Math.round(parseInt(base.font) * fontScale);
  const family = base.font.replace(/^\d+px\s*/, "");
  return {
    font: `${size}px ${family}`,
    lineHeight: Math.round(base.lineHeight * fontScale),
  };
}

const prepareCache = new Map<string, PreparedText>();

function getCacheKey(text: string, font: string): string {
  return `${font}::${text}`;
}

export function prepareText(text: string, profile: FontProfile, fontScale = 1): PreparedText {
  const { font } = getFontProfile(profile, fontScale);
  const key = getCacheKey(text, font);
  let prepared = prepareCache.get(key);
  if (!prepared) {
    prepared = prepare(text, font);
    prepareCache.set(key, prepared);
  }
  return prepared;
}

export function measureText(
  text: string,
  maxWidth: number,
  profile: FontProfile,
  fontScale = 1,
): LayoutResult {
  const prepared = prepareText(text, profile, fontScale);
  const { lineHeight } = getFontProfile(profile, fontScale);
  return layout(prepared, maxWidth, lineHeight);
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

function stripMarkdownSyntax(content: string): string {
  let text = content;
  text = text.replace(CODE_BLOCK_RE, "");
  text = text.replace(INLINE_CODE_RE, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/^\s*[-*+]\s+/gm, "  ");
  text = text.replace(/^\s*\d+\.\s+/gm, "   ");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
  return text;
}

function extractCodeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const matches = content.matchAll(CODE_BLOCK_RE);
  for (const match of matches) {
    const raw = match[0];
    const lines = raw.split("\n");
    const code = lines.slice(1, -1).join("\n");
    if (code.trim()) blocks.push(code);
  }
  return blocks;
}

export type MessageHeightEstimate = {
  textHeight: number;
  codeHeight: number;
  chromeHeight: number;
  totalHeight: number;
  lineCount: number;
};

const CODE_BLOCK_HEADER_HEIGHT = 32;
const CODE_BLOCK_PADDING = 24;
const MESSAGE_PADDING_VERTICAL = 24;
const MESSAGE_META_HEIGHT = 24;
const MESSAGE_ROLE_HEIGHT = 22;
const TOOL_CALL_COLLAPSED_HEIGHT = 32;
const IMAGE_ESTIMATED_HEIGHT = 200;

export function estimateMessageHeight(
  content: string | null | undefined,
  maxWidth: number,
  options: {
    fontScale?: number;
    hasRole?: boolean;
    hasMeta?: boolean;
    toolCallCount?: number;
    imageCount?: number;
    hasThinking?: boolean;
  } = {},
): MessageHeightEstimate {
  const {
    fontScale = 1,
    hasRole = false,
    hasMeta = false,
    toolCallCount = 0,
    imageCount = 0,
    hasThinking = false,
  } = options;

  if (!content) {
    let chrome = MESSAGE_PADDING_VERTICAL;
    if (hasRole) chrome += MESSAGE_ROLE_HEIGHT;
    if (hasMeta) chrome += MESSAGE_META_HEIGHT;
    chrome += toolCallCount * TOOL_CALL_COLLAPSED_HEIGHT;
    chrome += imageCount * IMAGE_ESTIMATED_HEIGHT;
    return { textHeight: 0, codeHeight: 0, chromeHeight: chrome, totalHeight: chrome, lineCount: 0 };
  }

  const contentWidth = Math.max(maxWidth - 64, 100);

  const proseText = stripMarkdownSyntax(content);
  const proseResult = measureText(proseText, contentWidth, "message", fontScale);

  const codeBlocks = extractCodeBlocks(content);
  let codeHeight = 0;
  let codeLines = 0;
  const codeWidth = Math.max(contentWidth - 24, 100);
  for (const block of codeBlocks) {
    const result = measureText(block, codeWidth, "code", fontScale);
    codeHeight += result.height + CODE_BLOCK_HEADER_HEIGHT + CODE_BLOCK_PADDING;
    codeLines += result.lineCount;
  }

  let chromeHeight = MESSAGE_PADDING_VERTICAL;
  if (hasRole) chromeHeight += MESSAGE_ROLE_HEIGHT;
  if (hasMeta) chromeHeight += MESSAGE_META_HEIGHT;
  if (hasThinking) chromeHeight += 36;
  chromeHeight += toolCallCount * TOOL_CALL_COLLAPSED_HEIGHT;
  chromeHeight += imageCount * IMAGE_ESTIMATED_HEIGHT;

  const totalHeight = proseResult.height + codeHeight + chromeHeight;

  return {
    textHeight: proseResult.height,
    codeHeight,
    chromeHeight,
    totalHeight,
    lineCount: proseResult.lineCount + codeLines,
  };
}

export function clearMeasureCache() {
  prepareCache.clear();
  clearCache();
}
