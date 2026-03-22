/**
 * Terminal Manager — PTY lifecycle, registry, and WebSocket broadcast.
 *
 * Each terminal is a persistent pseudo-terminal (via Bun.Terminal + Bun.spawn)
 * with zero or more WebSocket clients subscribed to its output. Input arrives
 * from WebSocket clients and is piped to the PTY's stdin.
 *
 * Designed so agent-attached terminals (Phase 2) can use the same primitives:
 * create, write, read, resize, kill.
 */

import {
  insertTerminal, markTerminalExited, getTerminal as dbGetTerminal,
  listActiveTerminals as dbListActive, deleteTerminalRow,
  type TerminalRow,
} from "./terminal-db";

// ── Types ──

export type TerminalClient = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
};

export type ActiveTerminal = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  sessionId: string | null;
  createdAt: number;
  proc: ReturnType<typeof Bun.spawn>;
  terminal: { write(data: string | Uint8Array): void; resize(cols: number, rows: number): void; close(): void };
  clients: Set<TerminalClient>;
  scrollback: Uint8Array[];
  scrollbackBytes: number;
};

// Max scrollback kept in memory per terminal (256 KB)
const MAX_SCROLLBACK_BYTES = 256 * 1024;

// In-memory registry of live terminals
const terminals = new Map<string, ActiveTerminal>();

// ── Helpers ──

function generateId(): string {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ──

export type CreateTerminalOpts = {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  sessionId?: string;
  env?: Record<string, string>;
};

export function createTerminal(opts: CreateTerminalOpts = {}): ActiveTerminal {
  const id = generateId();
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const sessionId = opts.sessionId ?? null;

  const clients = new Set<TerminalClient>();
  const scrollback: Uint8Array[] = [];
  let scrollbackBytes = 0;

  const proc = Bun.spawn([shell], {
    cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      data(_term: unknown, data: Uint8Array) {
        // Accumulate scrollback
        scrollback.push(data);
        scrollbackBytes += data.byteLength;

        // Evict oldest chunks if over limit
        while (scrollbackBytes > MAX_SCROLLBACK_BYTES && scrollback.length > 1) {
          const removed = scrollback.shift()!;
          scrollbackBytes -= removed.byteLength;
        }
        active.scrollbackBytes = scrollbackBytes;

        // Broadcast to all connected WebSocket clients
        for (const client of clients) {
          try {
            client.send(data);
          } catch {
            clients.delete(client);
          }
        }
      },
    },
  });

  const active: ActiveTerminal = {
    id,
    shell,
    cwd,
    cols,
    rows,
    sessionId,
    createdAt: Date.now(),
    proc,
    terminal: proc.terminal!,
    clients,
    scrollback,
    scrollbackBytes,
  };

  terminals.set(id, active);
  insertTerminal(id, shell, cwd, cols, rows, sessionId);

  // Handle process exit
  proc.exited.then((code) => {
    markTerminalExited(id, code ?? null);
    // Notify all clients the terminal exited
    const exitMsg = JSON.stringify({ type: "exit", code });
    for (const client of clients) {
      try {
        client.send(exitMsg);
        client.close();
      } catch { /* ignore */ }
    }
    clients.clear();
    terminals.delete(id);
  });

  return active;
}

export function writeTerminal(id: string, data: string | Uint8Array): boolean {
  const t = terminals.get(id);
  if (!t) return false;
  t.terminal.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const t = terminals.get(id);
  if (!t) return false;
  t.terminal.resize(cols, rows);
  t.cols = cols;
  t.rows = rows;
  return true;
}

export function killTerminal(id: string): boolean {
  const t = terminals.get(id);
  if (!t) return false;
  try {
    t.proc.kill("SIGTERM");
    // Force kill after 3s if still alive
    setTimeout(() => {
      try { t.proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 3000);
  } catch { /* already dead */ }
  return true;
}

export function getActiveTerminal(id: string): ActiveTerminal | undefined {
  return terminals.get(id);
}

export function getAllActiveTerminals(): ActiveTerminal[] {
  return [...terminals.values()];
}

export function getTerminalInfo(id: string): TerminalRow | null {
  return dbGetTerminal(id);
}

export function listAllTerminals(): TerminalRow[] {
  return dbListActive();
}

/** Attach a WebSocket client to a terminal. Returns scrollback chunks to replay. */
export function attachClient(id: string, client: TerminalClient): Uint8Array[] | null {
  const t = terminals.get(id);
  if (!t) return null;
  t.clients.add(client);
  return [...t.scrollback];
}

export function detachClient(id: string, client: TerminalClient): void {
  const t = terminals.get(id);
  if (!t) return;
  t.clients.delete(client);
}

/** Kill all terminals — called during graceful shutdown. */
export function shutdownAllTerminals(): void {
  for (const [id] of terminals) {
    killTerminal(id);
  }
}
