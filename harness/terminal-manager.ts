/**
 * Terminal Manager — PTY lifecycle, registry, and WebSocket broadcast.
 *
 * Each terminal is a persistent pseudo-terminal with zero or more WebSocket
 * clients subscribed to its output. Input arrives from WebSocket clients
 * and is piped to the PTY's stdin.
 *
 * - Linux/macOS: uses Bun.spawn with `terminal` option (native PTY)
 * - Windows: uses bun-pty (ConPTY via Rust FFI)
 *
 * Designed so agent-attached terminals (Phase 2) can use the same primitives:
 * create, write, read, resize, kill.
 */

import {
  insertTerminal, markTerminalExited, getTerminal as dbGetTerminal,
  listActiveTerminals as dbListActive, deleteTerminalRow, updateTerminalSessionId as dbUpdateTerminalSessionId,
  type TerminalRow,
} from "./terminal-db";

// ── Platform ──

const IS_WINDOWS = process.platform === "win32";

function getDefaultShell(): string {
  if (IS_WINDOWS) {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

// ── Types ──

export type TerminalClient = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
};

/** Minimal process handle — abstracts Bun.spawn and bun-pty */
type TerminalProcess = {
  kill(signal?: string): void;
  exited: Promise<number | null>;
};

export type ActiveTerminal = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  sessionId: string | null;
  createdAt: number;
  proc: TerminalProcess;
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

const encoder = new TextEncoder();

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
  const shell = opts.shell ?? getDefaultShell();
  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const sessionId = opts.sessionId ?? null;

  const clients = new Set<TerminalClient>();
  const scrollback: Uint8Array[] = [];
  let scrollbackBytes = 0;

  // `active` is referenced via closure — assigned after construction below
  let active: ActiveTerminal;
  function onData(data: Uint8Array) {
    scrollback.push(data);
    scrollbackBytes += data.byteLength;

    while (scrollbackBytes > MAX_SCROLLBACK_BYTES && scrollback.length > 1) {
      const removed = scrollback.shift()!;
      scrollbackBytes -= removed.byteLength;
    }
    if (active) active.scrollbackBytes = scrollbackBytes;

    for (const client of clients) {
      try {
        client.send(data);
      } catch {
        clients.delete(client);
      }
    }
  }

  let proc: TerminalProcess;
  let terminal: ActiveTerminal["terminal"];

  if (IS_WINDOWS) {
    // Windows: real PTY via bun-pty (ConPTY)
    const { spawn: ptySpawn } = require("bun-pty");
    const pty = ptySpawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, ...opts.env },
    });

    // bun-pty onData delivers strings — encode to Uint8Array for our pipeline
    pty.onData((data: string) => {
      onData(encoder.encode(data));
    });

    // Build exited promise from onExit event
    const exitedPromise = new Promise<number | null>((resolve) => {
      pty.onExit((e: { exitCode: number }) => {
        resolve(e.exitCode);
      });
    });

    proc = {
      kill(signal?: string) { pty.kill(signal); },
      exited: exitedPromise,
    };

    terminal = {
      write(data: string | Uint8Array) {
        pty.write(typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      resize(c: number, r: number) { pty.resize(c, r); },
      close() { pty.kill(); },
    };
  } else {
    // Unix: native PTY via Bun.spawn
    const bunProc = Bun.spawn([shell], {
      cwd,
      env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
      terminal: {
        cols,
        rows,
        data(_term: unknown, data: Uint8Array) {
          onData(data);
        },
      },
    });

    proc = {
      kill(signal?: string) { bunProc.kill(signal as any); },
      exited: bunProc.exited.then((code) => code ?? null),
    };
    terminal = bunProc.terminal!;
  }

  active = {
    id,
    shell,
    cwd,
    cols,
    rows,
    sessionId,
    createdAt: Date.now(),
    proc,
    terminal,
    clients,
    scrollback,
    scrollbackBytes,
  };

  terminals.set(id, active);
  insertTerminal(id, shell, cwd, cols, rows, sessionId);

  // Handle process exit
  proc.exited.then((code) => {
    markTerminalExited(id, code ?? null);
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
    if (IS_WINDOWS) {
      t.proc.kill();
    } else {
      t.proc.kill("SIGTERM");
      setTimeout(() => {
        try { t.proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 3000);
    }
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

/** Update the session ID for a terminal (e.g. after rekey). */
export function updateTerminalSession(terminalId: string, newSessionId: string): void {
  const t = terminals.get(terminalId);
  if (t) t.sessionId = newSessionId;
  dbUpdateTerminalSessionId(terminalId, newSessionId);
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

/**
 * Register an externally-spawned process as a terminal so the UI can attach to it.
 * The caller is responsible for piping data via the returned `pushData` callback.
 * The terminal system handles scrollback, WebSocket broadcast, and client management.
 * The caller retains full control of the process lifecycle.
 */
export function registerExternalTerminal(opts: {
  id?: string;
  sessionId?: string;
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  /** Called when a WebSocket client sends input (keystrokes). Optional. */
  onInput?: (data: string | Uint8Array) => void;
  /** Called when process exits (from terminal-manager's perspective). */
  exited: Promise<number | null>;
}): { id: string; pushData: (data: Uint8Array) => void; unregister: () => void } {
  const id = opts.id ?? generateId();
  const shell = opts.shell ?? "claude";
  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const sessionId = opts.sessionId ?? null;

  const clients = new Set<TerminalClient>();
  const scrollback: Uint8Array[] = [];
  let scrollbackBytes = 0;

  function pushData(data: Uint8Array) {
    scrollback.push(data);
    scrollbackBytes += data.byteLength;
    while (scrollbackBytes > MAX_SCROLLBACK_BYTES && scrollback.length > 1) {
      const removed = scrollback.shift()!;
      scrollbackBytes -= removed.byteLength;
    }
    if (active) active.scrollbackBytes = scrollbackBytes;
    for (const client of clients) {
      try { client.send(data); } catch { clients.delete(client); }
    }
  }

  // Stub process/terminal — the real process is managed externally
  const proc: TerminalProcess = {
    kill() { /* no-op: caller manages process */ },
    exited: opts.exited,
  };
  const terminal: ActiveTerminal["terminal"] = {
    write(data: string | Uint8Array) {
      if (opts.onInput) opts.onInput(data);
    },
    resize() { /* no-op for now */ },
    close() { /* no-op: caller manages process */ },
  };

  const active: ActiveTerminal = {
    id, shell, cwd, cols, rows, sessionId,
    createdAt: Date.now(),
    proc, terminal, clients, scrollback, scrollbackBytes,
  };

  terminals.set(id, active);
  insertTerminal(id, shell, cwd, cols, rows, sessionId);

  opts.exited.then((code) => {
    markTerminalExited(id, code ?? null);
    const exitMsg = JSON.stringify({ type: "exit", code });
    for (const client of clients) {
      try { client.send(exitMsg); client.close(); } catch { /* ignore */ }
    }
    clients.clear();
    terminals.delete(id);
  });

  function unregister() {
    markTerminalExited(id, null);
    for (const client of clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    clients.clear();
    terminals.delete(id);
  }

  return { id, pushData, unregister };
}

/** Kill all terminals — called during graceful shutdown. */
export function shutdownAllTerminals(): void {
  for (const [id] of terminals) {
    killTerminal(id);
  }
}
