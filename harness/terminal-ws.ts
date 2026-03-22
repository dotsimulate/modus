/**
 * Terminal WebSocket handler — binary PTY I/O over WebSocket.
 *
 * Protocol:
 *   - Binary frames (client→server): raw PTY input (keystrokes)
 *   - Binary frames (server→client): raw PTY output (terminal data)
 *   - Text frames (client→server): JSON control messages:
 *       { type: "resize", cols: number, rows: number }
 *       { type: "ping" }
 *   - Text frames (server→client): JSON control messages:
 *       { type: "exit", code: number | null }
 *       { type: "pong" }
 *       { type: "error", message: string }
 *
 * Auth:
 *   WebSocket connections authenticate via ?token= query parameter,
 *   validated by the same auth function used for REST endpoints.
 *
 * Integration:
 *   This module exports a Bun WebSocket handler object to be passed
 *   to Bun.serve({ websocket: ... }). The upgrade happens in the
 *   fetch wrapper in index.ts.
 */

import {
  attachClient, detachClient, writeTerminal, resizeTerminal,
  getActiveTerminal, type TerminalClient,
} from "./terminal-manager";

// ── Types ──

type WSData = {
  terminalId: string;
};

// ── Auth ──

/** Set by index.ts at startup */
let _checkAuth: (token: string) => boolean = () => true;

export function setAuthChecker(fn: (token: string) => boolean): void {
  _checkAuth = fn;
}

// ── Upgrade helper (called from fetch wrapper in index.ts) ──

/**
 * Attempts to upgrade a request to a terminal WebSocket.
 * Returns true if the request was handled (upgraded or rejected), false if not a terminal WS path.
 */
export function tryUpgradeTerminalWS(
  req: Request,
  server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
): Response | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  if (!match) return null;

  const terminalId = match[1]!;
  const token = url.searchParams.get("token") ?? "";

  // Auth check
  if (!_checkAuth(token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Verify terminal exists
  if (!getActiveTerminal(terminalId)) {
    return new Response("Terminal not found", { status: 404 });
  }

  const upgraded = server.upgrade(req, { data: { terminalId } as WSData });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Return null to signal the upgrade was handled (Bun returns undefined for upgrades)
  return undefined as unknown as Response;
}

// ── Bun WebSocket handler ──

export const terminalWebSocket = {
  open(ws: { data: WSData; send(data: string | ArrayBuffer | Uint8Array): void; close(): void }) {
    const { terminalId } = ws.data;

    const client: TerminalClient = {
      send(data) { ws.send(data); },
      close() { ws.close(); },
    };

    // Attach and replay scrollback
    const scrollback = attachClient(terminalId, client);
    if (!scrollback) {
      ws.send(JSON.stringify({ type: "error", message: "Terminal not found" }));
      ws.close();
      return;
    }

    // Store client ref on ws for detach in close handler
    (ws as any)._termClient = client;

    // Replay scrollback so the client sees existing output
    for (const chunk of scrollback) {
      ws.send(chunk);
    }
  },

  message(ws: { data: WSData; send(data: string | ArrayBuffer | Uint8Array): void }, message: string | ArrayBuffer | Uint8Array) {
    const { terminalId } = ws.data;

    // Binary frame → PTY input
    if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
      const data = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
      writeTerminal(terminalId, data);
      return;
    }

    // Text frame → JSON control message
    if (typeof message === "string") {
      try {
        const ctrl = JSON.parse(message);
        switch (ctrl.type) {
          case "resize":
            if (typeof ctrl.cols === "number" && typeof ctrl.rows === "number") {
              resizeTerminal(terminalId, ctrl.cols, ctrl.rows);
            }
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: `Unknown control type: ${ctrl.type}` }));
        }
      } catch {
        // Not JSON — treat as raw text input to PTY
        writeTerminal(terminalId, message);
      }
    }
  },

  close(ws: { data: WSData }) {
    const { terminalId } = ws.data;
    const client = (ws as any)._termClient as TerminalClient | undefined;
    if (client) {
      detachClient(terminalId, client);
    }
  },
};
