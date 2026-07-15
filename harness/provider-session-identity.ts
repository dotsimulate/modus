import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ResumeTargetSource = "persisted" | "legacy-exact" | "legacy-observed" | "none";

export type ResumeTargetSelection = {
  target: string | null;
  source: ResumeTargetSource;
  error?: string;
};

export function claudeNativeHistoryExists(providerSessionId: string): boolean {
  if (!providerSessionId || !/^[A-Za-z0-9_-]+$/.test(providerSessionId)) return false;
  const projectsRoot = join(homedir(), ".claude", "projects");
  try {
    if (existsSync(join(projectsRoot, `${providerSessionId}.jsonl`))) return true;
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projectsRoot, entry.name, `${providerSessionId}.jsonl`))) {
        return true;
      }
    }
  } catch { /* missing/unreadable Claude state */ }
  return false;
}

/**
 * Select a provider-native resume target without ever guessing that a Modus ID
 * is valid. Persisted identity is authoritative. Legacy fallbacks are accepted
 * only when the provider can prove the corresponding native history exists.
 */
export function selectProviderResumeTarget(
  input: {
    needsResume: boolean;
    modusSessionId: string;
    persistedProviderSessionId?: string | null;
    observedProviderSessionIds?: string[];
    providerLabel: string;
  },
  nativeHistoryExists: (providerSessionId: string) => boolean,
): ResumeTargetSelection {
  if (!input.needsResume) return { target: null, source: "none" };

  const persisted = input.persistedProviderSessionId?.trim();
  if (persisted) {
    if (nativeHistoryExists(persisted)) return { target: persisted, source: "persisted" };
    return {
      target: null,
      source: "persisted",
      error: `${input.providerLabel} native history ${persisted} is missing; refusing to start a context-free replacement`,
    };
  }

  // The first init event is the strongest pre-migration identity evidence.
  // Prefer it over the Modus ID: a prior bad resume may have created a second,
  // context-free native file whose ID happens to equal the Modus row ID.
  for (const candidate of input.observedProviderSessionIds ?? []) {
    if (candidate && nativeHistoryExists(candidate)) {
      return { target: candidate, source: "legacy-observed" };
    }
  }

  // Compatibility for sessions with no usable init event whose Modus ID truly
  // was the provider ID. Existence is mandatory; equality alone proves nothing.
  if (nativeHistoryExists(input.modusSessionId)) {
    return { target: input.modusSessionId, source: "legacy-exact" };
  }

  return {
    target: null,
    source: "none",
    error: `${input.providerLabel} has persisted Modus history but no verifiable native conversation; refusing to start fresh`,
  };
}
