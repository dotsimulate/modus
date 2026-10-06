import { BoundedCache } from "./bounded-cache";
import { reconstructSessionTurns, summarizeTurnDetails, type SessionHistoryEventRow } from "./session-history";
import type { TurnContent } from "./db";

type CachedPage = { events: SessionHistoryEventRow[]; turns: TurnContent[] };
const pages = new BoundedCache<string, CachedPage>(32, 32 * 1024 * 1024);

/**
 * Compare actual row contents, not a guessed sequence watermark: legacy
 * providers can reset seq, rows can be pruned/rekeyed, and maintenance can edit
 * the database through another connection. Count the retained source strings
 * against the same budget as summaries. Artifact attachment stays outside.
 */
export function reconstructCachedSessionTurns(
  events: SessionHistoryEventRow[],
  fallbackModel = "",
  includeDetails = true,
): TurnContent[] {
  // Cloning a full tool-heavy page costs as much as rebuilding it. Cache only
  // summaries, where repeated reads otherwise parse details just to discard them.
  if (includeDetails) return reconstructSessionTurns(events, fallbackModel);
  const sourceCharacters = events.reduce((size, event) => size + event.data.length, 0);
  if (sourceCharacters < 32_768 || sourceCharacters > 15 * 1024 * 1024) {
    return reconstructSessionTurns(events, fallbackModel).map(summarizeTurnDetails);
  }
  const key = JSON.stringify([fallbackModel, events.map((event) => [
    event.id, event.seq, event.type, event.subtype, event.created_at,
  ])]);
  const cached = pages.get(key);
  if (cached && events.every((event, index) => event.data === cached.events[index]!.data)) {
    return structuredClone(cached.turns);
  }

  const reconstructed = reconstructSessionTurns(events, fallbackModel);
  const turns = reconstructed.map(summarizeTurnDetails);
  const weight = 2 * (sourceCharacters + key.length + JSON.stringify(turns).length);
  // Never hand out the cached object: callers may enrich their own copy.
  pages.set(key, { events: events.map((event) => ({ ...event })), turns: structuredClone(turns) }, weight);
  return turns;
}
