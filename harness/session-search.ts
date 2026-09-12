export type SearchSort = "relevance" | "latest" | "oldest";

export type SearchOptions = {
  limit?: number;
  offset?: number;
  sort?: SearchSort;
  userProfile?: string;
};

/** Compile plain words and quoted phrases, never raw FTS operators. */
export function parseSessionSearch(query: string): { text: string; fts: string }[] {
  if (query.length > 4096) throw new Error("Search query must be at most 4096 characters.");
  const terms = new Map<string, { text: string; fts: string }>();
  for (const match of query.matchAll(/"([^"]*)"?|([^\s"]+)/gu)) {
    const quoted = match[1] !== undefined;
    const words = (match[1] ?? match[2] ?? "").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    for (const text of quoted ? (words.length ? [words.join(" ")] : []) : words) {
      const fts = `"${text}"${quoted ? "" : "*"}`;
      terms.set(fts.toLowerCase(), { text, fts });
    }
  }
  if (terms.size > 32) throw new Error("Search supports at most 32 terms or phrases.");
  return [...terms.values()];
}

export function normalizeSearchSort(sort?: string | null): SearchSort {
  return sort === "latest" || sort === "oldest" ? sort : "relevance";
}

export function normalizeSearchLimit(limit = 20): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 20;
}

export function normalizeSearchOffset(offset = 0): number {
  return Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
}
