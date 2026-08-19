/**
 * Prompt cache — client-side store, synced with the Bun server.
 *
 * The server owns the canonical JSON file at <current-home>/profiles/prompt-cache.json.
 * This module caches it in memory, supports subscriptions for UI updates, and
 * pushes changes back to the server as whole-file PUTs.
 */

import { useSyncExternalStore } from "react";
import type { PromptCache, PromptCacheEntry } from "../../sdk/index";
import { modus } from "./modusClient";

let cache: PromptCache = { prompts: [] };
let loaded = false;
let loadingPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPromptCache(): PromptCache {
  return cache;
}

/** Load once from the server. Safe to call repeatedly — returns cached promise. */
export function loadPromptCache(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  loadingPromise = modus.getPromptCache()
    .then((data) => {
      cache = data && Array.isArray(data.prompts) ? data : { prompts: [] };
      loaded = true;
      notify();
    })
    .catch(() => {
      cache = { prompts: [] };
      loaded = true;
      notify();
    });
  return loadingPromise;
}

async function persist() {
  try {
    await modus.savePromptCache(cache);
  } catch (err) {
    console.error("[promptCache] failed to save:", err);
  }
}

function makeId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a prompt. Dedupes by exact text match — existing duplicate is moved to top. */
export function addPrompt(text: string): PromptCacheEntry | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const existing = cache.prompts.find((p) => p.text === trimmed);
  const now = Date.now();
  if (existing) {
    existing.savedAt = now;
    cache = {
      prompts: [existing, ...cache.prompts.filter((p) => p.id !== existing.id)],
    };
    notify();
    void persist();
    return existing;
  }
  const entry: PromptCacheEntry = { id: makeId(), text: trimmed, savedAt: now };
  cache = { prompts: [entry, ...cache.prompts] };
  notify();
  void persist();
  return entry;
}

export function removePrompt(id: string): void {
  const next = cache.prompts.filter((p) => p.id !== id);
  if (next.length === cache.prompts.length) return;
  cache = { prompts: next };
  notify();
  void persist();
}

/** Find the most-recently-saved cached entry whose text starts with the given prefix (case-insensitive).
 *  Returns the suffix that would complete it, or null if no match. The `prompts` array is
 *  ordered most-recent-first, so iterating forward picks the freshest match. */
export function findCompletion(prefix: string): string | null {
  if (!prefix) return null;
  const lower = prefix.toLowerCase();
  for (const entry of cache.prompts) {
    if (entry.text.length <= prefix.length) continue;
    if (entry.text.toLowerCase().startsWith(lower)) {
      return entry.text.slice(prefix.length);
    }
  }
  return null;
}

/** React hook — re-renders when the cache changes. */
export function usePromptCache(): PromptCache {
  return useSyncExternalStore(subscribe, getPromptCache, getPromptCache);
}
