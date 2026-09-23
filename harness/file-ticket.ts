/**
 * Short-lived, path-bound tickets for `GET /api/file/raw`.
 *
 * That route used to accept the caller's browser-session credential in the query
 * string, because the three things the UI does with a raw-file URL — open it in a
 * tab, point an `<img>` at it, hand it to the share sheet — cannot set an
 * `Authorization` header. The cost was that every such URL carried a credential
 * good for the *entire* API, into browser history, into whatever the user pasted
 * it into, and into any log that records query strings.
 *
 * A ticket is the same affordance with the authority removed. It authorizes one
 * path, for a few minutes, and nothing else. Minting still requires the real
 * credential on a header, so a ticket never grants more than its minter had.
 *
 * In memory on purpose: a ticket that survives a restart outlives the tab that
 * needed it. Losing them on restart is the correct failure.
 */

import { resolve } from "path";

const TICKET_PREFIX = "ft-";
const DEFAULT_TTL_MS = 5 * 60_000;

/** Bound so a leaked ticket cannot be replayed indefinitely, and so the map cannot grow without limit. */
export const FILE_TICKET_TTL_MS = DEFAULT_TTL_MS;
const MAX_TICKETS = 500;

type FileTicket = {
  /** Resolved absolute path. Comparison is on this, never the raw query value. */
  path: string;
  expiresAt: number;
  /** Browser-issued tickets die with the session that minted them. */
  browserSession?: string;
};

const tickets = new Map<string, FileTicket>();

function sweep(now: number): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
  // A burst of mints must not pin memory: drop the oldest beyond the cap.
  if (tickets.size <= MAX_TICKETS) return;
  const ordered = [...tickets.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [ticket] of ordered.slice(0, tickets.size - MAX_TICKETS)) {
    tickets.delete(ticket);
  }
}

/** Mint a ticket for one file. The caller must already be authorized. */
export function mintFileTicket(filePath: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS, browserSession?: string): string {
  sweep(now);
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const ticket = TICKET_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  tickets.set(ticket, { path: resolve(filePath), expiresAt: now + ttlMs, browserSession });
  return ticket;
}

export function isFileTicket(value: string): boolean {
  return value.startsWith(TICKET_PREFIX);
}

/**
 * True only for this exact file, before expiry.
 *
 * Tickets are deliberately reusable until they expire: a browser may re-request
 * the same image on a reload or a range request, and a single-use ticket would
 * turn that into a broken image the user cannot explain.
 */
export function validateFileTicket(ticket: string, filePath: string, now = Date.now()): boolean {
  const entry = tickets.get(ticket);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    tickets.delete(ticket);
    return false;
  }
  return entry.path === resolve(filePath);
}

/** Invalidate browser-issued URLs when their authorizing browser session is revoked. */
export function revokeBrowserFileTickets(tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const revoked = new Set(tokens);
  for (const [ticket, entry] of tickets) {
    if (entry.browserSession && revoked.has(entry.browserSession)) tickets.delete(ticket);
  }
}

/** Test seam — the store is process-global and would otherwise leak between cases. */
export function clearFileTickets(): void {
  tickets.clear();
}
