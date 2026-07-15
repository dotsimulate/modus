import type { Message, TouchRecord } from "../../sdk/index";
import { extractFileEdits, groupByFile, type FileEdit } from "./components/FileChanges";

function filePathKey(filePath: string, cwd?: string | null): string {
  let normalized = filePath.replace(/\\/g, "/");
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!isAbsolute && cwd) normalized = `${cwd.replace(/\\/g, "/").replace(/\/$/, "")}/${normalized}`;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Trace is the session-wide source of truth for the file set. Loaded tool
 * payloads are optional enrichment: when present, they provide actual hunks.
 */
export function mergeSessionEdits(
  messages: Message[],
  touches: TouchRecord[],
  cwd?: string | null,
): Map<string, FileEdit[]> {
  const loaded: FileEdit[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      loaded.push(...extractFileEdits(message.toolCalls));
    }
  }

  const loadedGroups = groupByFile(loaded);
  const loadedByKey = new Map<string, { filePath: string; edits: FileEdit[] }>();
  for (const [filePath, edits] of loadedGroups) {
    loadedByKey.set(filePathKey(filePath, cwd), { filePath, edits });
  }

  const merged = new Map<string, FileEdit[]>();
  const represented = new Set<string>();
  for (const touch of touches) {
    if (touch.op !== "write" && touch.op !== "edit") continue;
    const key = filePathKey(touch.filePath, cwd);
    if (represented.has(key)) continue;
    represented.add(key);
    const detailed = loadedByKey.get(key);
    merged.set(
      touch.filePath,
      detailed?.edits ?? [{ filePath: touch.filePath, type: touch.op }],
    );
  }

  // Keep a graceful fallback for providers/tool formats the trace parser does
  // not know yet. This only prevents already-known edits from disappearing.
  for (const [key, detailed] of loadedByKey) {
    if (!represented.has(key)) merged.set(detailed.filePath, detailed.edits);
  }
  return merged;
}
