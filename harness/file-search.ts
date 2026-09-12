/**
 * File search — the argv-safety half of the Everything integration.
 *
 * `es.exe` is the voidtools Everything CLI. It takes the search as its final
 * positional argument, and it reads any argument beginning with a dash as a
 * switch — including that one. Several of its switches write: `-export-csv`,
 * `-export-txt`, `-save-settings`, `-clear-settings`, `-save-db`. A search box
 * wired straight through therefore hands a caller a way to make the search tool
 * do something other than search.
 *
 * Kept out of `index.ts` so the rule can be tested without booting the server.
 */

/** Everything's own escape: "Use double quotes to escape spaces and switches." */
const QUOTE = '"';

/**
 * Neutralize a query that `es.exe` would otherwise read as a switch.
 *
 * Only the leading token is at risk. The whole query travels as a single argv
 * element, so `es.exe` never re-splits it — `foo -clear-settings` is one search
 * term and is harmless, while `-clear-settings` alone is a switch. Quoting just
 * that token keeps the rest of the query verbatim, so multi-term AND, operators
 * and functions all still mean what the user typed.
 */
export function escapeEverythingQuery(query: string): string {
  if (!query.startsWith("-")) return query;
  const boundary = query.search(/\s/);
  const head = boundary === -1 ? query : query.slice(0, boundary);
  const tail = boundary === -1 ? "" : query.slice(boundary);
  // A quote inside the token being quoted would close it early; drop it rather
  // than emit a malformed argument and let es.exe guess.
  return `${QUOTE}${head.split(QUOTE).join("")}${QUOTE}${tail}`;
}
