/**
 * URLs for `GET /api/file/raw`.
 *
 * Three places need a raw-file URL that no header can be attached to: an `<img>`
 * src, an open-in-a-new-tab link, and a link handed to the share sheet. Those
 * used to carry the caller's whole-API credential in the query string. They now
 * carry a ticket minted for that one path, which expires in minutes.
 *
 * The URL construction is pure and lives here so it can be tested — `harness/ui`
 * has no DOM test environment, so anything worth pinning has to be logic rather
 * than a component.
 */

import { shareableBackendUrl } from "./backendTarget";
import { API_BASE, authHeaders } from "./modusClient";

/** Build the URL. Pure — the ticket is already minted. */
export function buildRawFileUrl(apiBase: string, filePath: string, ticket: string): string {
  const query = `path=${encodeURIComponent(filePath)}&ticket=${encodeURIComponent(ticket)}`;
  return `${apiBase}/api/file/raw?${query}`;
}

/** Same URL, absolute, so it survives leaving this document. */
export function buildShareableRawFileUrl(filePath: string, ticket: string, pageOrigin?: string): string {
  const query = `path=${encodeURIComponent(filePath)}&ticket=${encodeURIComponent(ticket)}`;
  return shareableBackendUrl(`/api/file/raw?${query}`, pageOrigin);
}

/**
 * Ask the backend for a ticket. Returns "" when it refuses, so callers render
 * nothing rather than a URL that will 401 — a broken image with no explanation
 * is the worst of the available failures.
 */
export async function mintFileTicket(filePath: string): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/api/file/ticket`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) return "";
    const body = await res.json() as { ticket?: string };
    return typeof body.ticket === "string" ? body.ticket : "";
  } catch {
    return "";
  }
}

/** A ready-to-use raw-file URL, or "" when a ticket could not be minted. */
export async function ticketedRawFileUrl(filePath: string): Promise<string> {
  const ticket = await mintFileTicket(filePath);
  return ticket ? buildRawFileUrl(API_BASE, filePath, ticket) : "";
}

/** The shareable form of the same. */
export async function ticketedShareableFileUrl(filePath: string, pageOrigin?: string): Promise<string> {
  const ticket = await mintFileTicket(filePath);
  return ticket ? buildShareableRawFileUrl(filePath, ticket, pageOrigin) : "";
}
