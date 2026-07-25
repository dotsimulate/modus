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
 *   WebSocket connections authenticate with a base64url bearer carried in the
 *   Sec-WebSocket-Protocol request header, never in a query string.
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
  authToken: string;
};

type TerminalSocket = {
  data: WSData;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  _termClient?: TerminalClient;
};

function closeForTerminalIoFailure(ws: TerminalSocket): void {
  try {
    ws.send(JSON.stringify({ type: "error", message: "Terminal input stream is closed" }));
  } catch {}
  try { ws.close(); } catch {}
}

// ── Auth ──

/** Set by index.ts at startup */
let _checkAuth: (token: string) => boolean = () => true;
let _checkOrigin: (origin: string | null, req: Request) => boolean = (origin) => !origin;
const socketsByToken = new Map<string, Set<TerminalSocket>>();

export function setAuthChecker(fn: (token: string) => boolean): void {
  _checkAuth = fn;
}

/** Browser WebSockets always send Origin. Requests without Origin are reserved
 * for non-browser SDK/CLI clients and are evaluated by the configured policy. */
export function setOriginChecker(fn: (origin: string | null, req: Request) => boolean): void {
  _checkOrigin = fn;
}

export function closeTerminalWebSockets(tokens: readonly string[]): void {
  for (const token of tokens) {
    const sockets = socketsByToken.get(token);
    socketsByToken.delete(token);
    for (const socket of sockets ?? []) {
      try {
        socket.send(JSON.stringify({ type: "error", message: "Modus session revoked" }));
        socket.close();
      } catch { /* an already-closed socket is already revoked */ }
    }
  }
}

const AUTH_PROTOCOL_PREFIX = "modus-auth.";

function protocolToken(req: Request): string {
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((value) => value.trim());
  const encoded = protocols
    .find((value) => value.startsWith(AUTH_PROTOCOL_PREFIX))
    ?.slice(AUTH_PROTOCOL_PREFIX.length);
  if (!encoded) return "";
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

// ── Upgrade helper (called from fetch wrapper in index.ts) ──

/**
 * Attempts to upgrade a request to a terminal WebSocket.
 * Returns true if the request was handled (upgraded or rejected), false if not a terminal WS path.
 */
export function tryUpgradeTerminalWS(
  req: Request,
  server: { upgrade(req: Request, opts: { data: WSData; headers?: Record<string, string> }): boolean },
): Response | null {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  if (!match) return null;

  const terminalId = match[1]!;
  const token = protocolToken(req);

  if (!_checkOrigin(req.headers.get("Origin"), req)) {
    return new Response("Forbidden origin", { status: 403 });
  }

  // Auth check
  if (!_checkAuth(token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Verify terminal exists
  if (!getActiveTerminal(terminalId)) {
    return new Response("Terminal not found", { status: 404 });
  }

  const upgraded = server.upgrade(req, {
    data: { terminalId, authToken: token },
    headers: { "Sec-WebSocket-Protocol": "modus-v1" },
  });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Return null to signal the upgrade was handled (Bun returns undefined for upgrades)
  return undefined as unknown as Response;
}

// ── Bun WebSocket handler ──

export const terminalWebSocket = {
  open(ws: TerminalSocket) {
    const { terminalId, authToken } = ws.data;
    if (!_checkAuth(authToken)) {
      ws.close();
      return;
    }
    const sockets = socketsByToken.get(authToken) ?? new Set<TerminalSocket>();
    sockets.add(ws);
    socketsByToken.set(authToken, sockets);

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
    ws._termClient = client;

    // Replay scrollback so the client sees existing output
    for (const chunk of scrollback) {
      ws.send(chunk);
    }
  },

  message(ws: TerminalSocket, message: string | ArrayBuffer | Uint8Array) {
    const { terminalId, authToken } = ws.data;
    if (!_checkAuth(authToken)) {
      ws.close();
      return;
    }

    // Binary frame → PTY input
    if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
      const data = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
      if (!writeTerminal(terminalId, data)) closeForTerminalIoFailure(ws);
      return;
    }

    // Text frame → JSON control message
    if (typeof message === "string") {
      let ctrl: any;
      try {
        ctrl = JSON.parse(message);
      } catch {
        // Not JSON — treat as raw text input to PTY
        if (!writeTerminal(terminalId, message)) closeForTerminalIoFailure(ws);
        return;
      }
      switch (ctrl.type) {
        case "resize":
          if (
            typeof ctrl.cols === "number"
            && typeof ctrl.rows === "number"
            && !resizeTerminal(terminalId, ctrl.cols, ctrl.rows)
          ) {
            closeForTerminalIoFailure(ws);
          }
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown control type: ${ctrl.type}` }));
      }
    }
  },

  close(ws: TerminalSocket) {
    const { terminalId, authToken } = ws.data;
    const sockets = socketsByToken.get(authToken);
    sockets?.delete(ws);
    if (sockets?.size === 0) socketsByToken.delete(authToken);
    const client = ws._termClient;
    if (client) {
      detachClient(terminalId, client);
    }
  },
};
