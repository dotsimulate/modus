/**
 * Prompt cache — a shareable JSON file of saved prompts. Users select text
 * in the chat and "save to prompt cache"; the composer ghost-autocompletes
 * against these entries.
 *
 * Stored at ~/.modus/profiles/prompt-cache.json alongside the rest of the
 * user-scoped state (see harness/modus-home.ts).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { homePromptCachePath } from "./modus-home";
import { recordAttributionHint, scheduleCommit } from "./workspace-history";

const CACHE_PATH = homePromptCachePath();

export type PromptCacheEntry = {
  id: string;
  text: string;
  savedAt: number;
};

export type PromptCache = {
  prompts: PromptCacheEntry[];
};

const EMPTY: PromptCache = { prompts: [] };

export function getPromptCache(): PromptCache {
  if (!existsSync(CACHE_PATH)) return { ...EMPTY };
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (!data || !Array.isArray(data.prompts)) return { ...EMPTY };
    return data;
  } catch {
    return { ...EMPTY };
  }
}

export function savePromptCache(cache: PromptCache): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordAttributionHint({ kind: "user" }, CACHE_PATH, { type: "human" });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  scheduleCommit({ kind: "user" });
}
