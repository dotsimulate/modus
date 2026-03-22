/**
 * Terminal API client — REST + WebSocket for PTY terminals.
 */

import { API_BASE, authHeaders, getAuthToken } from "./_fetch";

// ── Types ──

export type TerminalInfo = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  sessionId: string | null;
  createdAt: number;
  clients?: number;
  status?: string;
};

export type CreateTerminalOpts = {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  sessionId?: string;
};

// ── REST ──

export async function createTerminal(opts: CreateTerminalOpts = {}): Promise<TerminalInfo> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`Failed to create terminal: ${res.status}`);
  return res.json();
}

export async function listTerminals(sessionId?: string): Promise<TerminalInfo[]> {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const res = await fetch(`${API_BASE}/api/terminals${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to list terminals: ${res.status}`);
  return res.json();
}

export async function getTerminal(id: string): Promise<TerminalInfo> {
  const res = await fetch(`${API_BASE}/api/terminals/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to get terminal: ${res.status}`);
  return res.json();
}

export async function deleteTerminal(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/terminals/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to delete terminal: ${res.status}`);
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/terminals/${id}/resize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cols, rows }),
  });
  if (!res.ok) throw new Error(`Failed to resize terminal: ${res.status}`);
}

// ── WebSocket ──

export function connectTerminalWS(terminalId: string): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const host = API_BASE ? new URL(API_BASE).host : location.host;
  const token = getAuthToken();
  const url = `${protocol}//${host}/ws/terminal/${terminalId}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return ws;
}
