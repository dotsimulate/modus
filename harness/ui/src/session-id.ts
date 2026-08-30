/**
 * Client-minted ids the composer uses before the harness has a durable
 * session. Init may replace these. A provider-native conversation id must
 * not — that is stored separately and swapping it in makes the UI subscribe
 * to a session the harness does not have (Grok ACP did this).
 */
export function isClientTempSessionId(id: string): boolean {
  return !id || id.startsWith("pending-") || id.startsWith("ses-");
}
