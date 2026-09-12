/**
 * Process memory sampling — resident set size for a spawned process tree.
 *
 * The session reaper needs to know how much memory a session is actually
 * responsible for before reclaiming it. Node exposes no cross-platform way to
 * read another process's RSS, so this module shells out once per sweep and
 * builds an in-memory table that callers query.
 *
 * Two numbers come out of a tree walk, and they mean different things:
 *   - `totalBytes`   every process below the roots, including whatever the
 *                    agent legitimately launched (builds, test runs, servers).
 *   - `matchedBytes` only the processes whose image is the provider's own CLI,
 *                    which is where a runaway agent runtime shows up.
 *
 * Keeping them apart is what lets a caller reclaim a leaking CLI without
 * touching a session whose subprocess is doing real work.
 */

import { execFile } from "node:child_process";

export type ProcessRow = {
  pid: number;
  ppid: number;
  /** Image name as the platform reports it, e.g. `claude.exe` or `claude`. */
  name: string;
  rssBytes: number;
};

export type ProcessTable = Map<number, ProcessRow>;

export type TreeFootprint = {
  /** Every pid reachable from the roots, including the roots themselves. */
  pids: number[];
  /** Resident bytes across the whole tree. */
  totalBytes: number;
  /** Resident bytes for tree members whose image matched the requested names. */
  matchedBytes: number;
};

/** Depth limit for the tree walk. Guards against parent cycles from pid reuse. */
const MAX_TREE_DEPTH = 32;

/**
 * Pids that own large parts of the process table on Windows (System Idle,
 * System). Descending into them would attribute the whole machine to one
 * session, so the walk stops there.
 */
const NON_DESCENDABLE_PIDS = new Set([0, 4]);

/** How long a sampled table stays usable before another spawn is needed. */
const SAMPLE_TTL_MS = 15_000;

const COMMAND_TIMEOUT_MS = 8_000;

// ── Name matching ──

/** Compare image names case-insensitively and ignore a Windows `.exe` suffix. */
export function normalizeImageName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

// ── Parsers ──
// Each parser is pure so the shapes these commands emit can be pinned by tests
// without spawning anything.

/**
 * Parse `wmic process get Name,ParentProcessId,ProcessId,WorkingSetSize /format:csv`.
 * Columns are resolved from the header row rather than by position — wmic
 * orders them alphabetically, which is not the order they were requested in.
 */
export function parseWmicProcessCsv(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headerIndex = lines.findIndex((line) => line.includes("ProcessId"));
  if (headerIndex < 0) return table;

  const header = lines[headerIndex]!.split(",").map((cell) => cell.trim());
  const pidAt = header.indexOf("ProcessId");
  const ppidAt = header.indexOf("ParentProcessId");
  const nameAt = header.indexOf("Name");
  const rssAt = header.indexOf("WorkingSetSize");
  if (pidAt < 0 || rssAt < 0) return table;

  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(",");
    if (cells.length <= pidAt) continue;
    const pid = Number(cells[pidAt]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: ppidAt >= 0 ? Number(cells[ppidAt]?.trim()) || 0 : 0,
      name: nameAt >= 0 ? (cells[nameAt]?.trim() ?? "") : "",
      rssBytes: Number(cells[rssAt]?.trim()) || 0,
    });
  }
  return table;
}

/**
 * Parse `tasklist /FO CSV /NH`, the fallback for machines where wmic has been
 * removed. tasklist reports no parent pid, so a table built from it supports
 * per-pid lookups but not a tree walk.
 *
 * Memory arrives as a locale-formatted kilobyte count (`"127,788 K"`, or
 * `"127.788 K"` where the separator differs). Discarding every non-digit is
 * correct for all of them because the value is always a whole number.
 */
export function parseTasklistCsv(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 5) continue;
    const unquoted = cells.map((cell) => cell.slice(1, -1));
    const pid = Number(unquoted[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const kilobytes = Number(unquoted[4]!.replace(/\D/g, ""));
    table.set(pid, {
      pid,
      ppid: 0,
      name: unquoted[0] ?? "",
      rssBytes: Number.isFinite(kilobytes) ? kilobytes * 1024 : 0,
    });
  }
  return table;
}

/** Parse `ps -eo pid=,ppid=,rss=,comm=`. `rss` is in kilobytes. */
export function parsePsOutput(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number(match[2]) || 0,
      name: (match[4] ?? "").trim(),
      rssBytes: Number(match[3]) * 1024,
    });
  }
  return table;
}

// ── Tree walk ──

/**
 * Sum resident memory across the process trees rooted at `roots`.
 *
 * `matchNames` are provider CLI names (`claude`, `codex`, …); tree members
 * whose image matches one of them are additionally summed into `matchedBytes`.
 * Roots that are no longer in the table have already exited and contribute
 * nothing.
 */
export function measureProcessTree(
  table: ProcessTable,
  roots: Iterable<number>,
  matchNames: Iterable<string> = [],
): TreeFootprint {
  const wanted = new Set<string>();
  for (const name of matchNames) wanted.add(normalizeImageName(name));

  const childrenOf = new Map<number, number[]>();
  for (const row of table.values()) {
    if (row.ppid === row.pid) continue;
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenOf.set(row.ppid, [row.pid]);
  }

  const seen = new Set<number>();
  const queue: Array<{ pid: number; depth: number }> = [];
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root);
      queue.push({ pid: root, depth: 0 });
    }
  }

  let totalBytes = 0;
  let matchedBytes = 0;
  const pids: number[] = [];

  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!;
    const row = table.get(pid);
    if (row) {
      pids.push(pid);
      totalBytes += row.rssBytes;
      if (wanted.has(normalizeImageName(row.name))) matchedBytes += row.rssBytes;
    }
    if (depth >= MAX_TREE_DEPTH || NON_DESCENDABLE_PIDS.has(pid)) continue;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push({ pid: child, depth: depth + 1 });
    }
  }

  return { pids, totalBytes, matchedBytes };
}

// ── Sampling ──

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => resolve(error || !stdout.trim() ? null : stdout));
  });
}

/** An independent sampler; injected commands let tests avoid the real process table. */
export function createProcessTableSampler(
  platform: string = process.platform,
  command: typeof runCommand = runCommand,
  clock: () => number = Date.now,
) {
  /** null until the first sample; false once wmic failed without ever working. */
  let wmicUsable: boolean | null = null;

  async function sampleWindows(): Promise<ProcessTable> {
    // wmic reports working set in bytes and includes the parent pid, so it is
    // preferred. It is being removed from Windows, hence the tasklist fallback.
    // Where it is already gone, asking again every sweep spawns a failing shell for
    // nothing, so a wmic that has never worked is not retried. One that has worked
    // keeps being tried: a single failure under load should not demote it.
    if (wmicUsable !== false) {
      const wmic = await command("cmd.exe", [
        "/c",
        "wmic process get Name,ParentProcessId,ProcessId,WorkingSetSize /format:csv",
      ]);
      const table = wmic ? parseWmicProcessCsv(wmic) : new Map();
      if (table.size > 0) {
        wmicUsable = true;
        return table;
      }
      if (wmicUsable === null) wmicUsable = false;
    }
    const tasklist = await command("tasklist", ["/FO", "CSV", "/NH"]);
    return tasklist ? parseTasklistCsv(tasklist) : new Map();
  }

  async function samplePosix(): Promise<ProcessTable> {
    const ps = await command("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
    return ps ? parsePsOutput(ps) : new Map();
  }

  let cachedTable: ProcessTable | null = null;
  let cachedAt = 0;
  let inFlight: Promise<ProcessTable> | null = null;
  let generation = 0;

  /**
   * Read the current process table. Results are cached briefly so several
   * lookups in one reaper sweep cost a single spawn. Returns an empty table when
   * the platform tooling is unavailable; callers must treat that as "unknown",
   * never as "zero".
   */
  function sample(): Promise<ProcessTable> {
    if (inFlight) return inFlight;
    if (cachedTable && clock() - cachedAt < SAMPLE_TTL_MS) return Promise.resolve(cachedTable);
    const startedGeneration = generation;
    const pending = (platform === "win32" ? sampleWindows() : samplePosix())
      .catch(() => new Map() as ProcessTable)
      .then((table) => {
        if (generation === startedGeneration) {
          cachedTable = table;
          cachedAt = clock();
        }
        return table;
      }).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  }

  /** Drop the cached table so the next sample re-reads the system. */
  function reset(): void {
    generation++;
    cachedTable = null;
    cachedAt = 0;
  }
  return { sample, reset };
}

const sampler = createProcessTableSampler();
export const sampleProcessTable = sampler.sample;
export const resetProcessTableCache = sampler.reset;
