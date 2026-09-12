import type { SearchHit, SearchOptions } from "../../sdk/index";

/** Cleanup invalidates both the debounce and any request already in flight. */
export function scheduleSessionSearch(
  search: (query: string, options: SearchOptions) => Promise<SearchHit[]>,
  query: string,
  options: SearchOptions,
  onResult: (hits: SearchHit[]) => void,
  onError: (error: unknown) => void,
): () => void {
  let active = true;
  const timer = setTimeout(async () => {
    try {
      const hits = await search(query, options);
      if (active) onResult(hits);
    } catch (error) {
      if (active) onError(error);
    }
  }, 250);
  return () => { active = false; clearTimeout(timer); };
}
