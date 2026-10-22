/**
 * Memory Guard — keeps agent processes from exhausting system memory.
 *
 * An agent runtime that grows without bound takes the whole machine with it:
 * once the OS runs out of physical memory and paging space, unrelated services
 * are terminated mid-write. Three limits defend against that, and they apply at
 * different moments:
 *
 * - Spawn time: `canSpawnSession()` refuses a new session past the concurrency
 *   cap or above the system pressure threshold.
 * - Process lifetime: `getMemoryLimitedEnv()` caps the V8 heap of spawned
 *   processes that run on Node. See its own note for the important limit.
 * - Idle lifetime: the session reaper reclaims sessions whose provider CLI has
 *   grown past `MG_MAX_HEAP_MB`, or any large idle session while the system is
 *   under pressure. `resolveReapLimits()` below configures it.
 *
 * The watchdog only reports; it never kills.
 */

import { execFileSync } from "child_process";
import { freemem, totalmem, platform } from "os";
import { readFileSync } from "fs";
import { DEFAULT_REAP_LIMITS, type ReapLimits } from "./session-reap-policy";
import { largestProcessGroups, sampleProcessTable, type ProcessGroupUsage } from "./process-memory";

// ── Accurate available memory ──
// Linux counts filesystem cache as "used", so os.availableMemory() (MemFree) severely
// underestimates available memory. MemAvailable includes reclaimable cache.
// macOS also keeps reclaimable memory in inactive/speculative/purgeable pages, while
// os.freemem() only reports immediately free pages.
function availableMemory(): number {
  if (platform() === "linux") {
    try {
      const info = readFileSync("/proc/meminfo", "utf8");
      const match = info.match(/MemAvailable:\s+(\d+)/);
      if (match) return Number(match[1]) * 1024; // kB → bytes
    } catch {}
  }

  if (platform() === "darwin") {
    try {
      const output = execFileSync("vm_stat", { encoding: "utf8" });
      const pageSizeMatch = output.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const pages = new Map<string, number>();

      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^Pages ([^:]+):\s+([\d.]+)/);
        const key = match?.[1];
        const value = match?.[2];
        if (key && value) pages.set(key.trim().toLowerCase(), Number(value.replace(".", "")));
      }

      const availablePages =
        (pages.get("free") ?? 0) +
        (pages.get("inactive") ?? 0) +
        (pages.get("speculative") ?? 0) +
        (pages.get("purgeable") ?? 0);

      if (availablePages > 0) return availablePages * pageSize;
    } catch {}
  }

  return freemem();
}

// ── Configuration (overridable via env) ──

/**
 * Memory ceiling for a single agent runtime (MB).
 *
 * Enforced two ways because one of them does not cover every provider:
 * `getMemoryLimitedEnv()` turns it into a V8 heap cap for CLIs that run on
 * Node, and the session reaper reclaims any idle session whose provider CLI has
 * grown past it, which is the only enforcement a natively compiled CLI gets.
 */
const MAX_HEAP_MB = Number(process.env.MG_MAX_HEAP_MB ?? 4096);

/** Max concurrent agent sessions. N × MAX_HEAP_MB = worst-case RAM. */
const DEFAULT_MAX_CONCURRENT = 10;
const configuredMaxConcurrent = Number(process.env.MG_MAX_CONCURRENT ?? DEFAULT_MAX_CONCURRENT);
let maxConcurrentSessions = Number.isSafeInteger(configuredMaxConcurrent) && configuredMaxConcurrent > 0
  ? configuredMaxConcurrent
  : DEFAULT_MAX_CONCURRENT;

/** Changes admission for future spawns only; never stops or restarts existing sessions. */
export function setMaxConcurrentSessions(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("maxConcurrentSessions must be a positive safe integer");
  }
  maxConcurrentSessions = value;
}

/** Block new sessions when system memory usage exceeds this ratio (0-1). */
const PRESSURE_THRESHOLD = Number(process.env.MG_PRESSURE_THRESHOLD ?? 0.90);

/**
 * Available memory (MB) that still admits a new session above the pressure ratio.
 *
 * A ratio alone scales badly: 10% of a 190 GB machine is 19 GB, several times
 * what one capped runtime can take. Spawning is refused only when the ratio is
 * crossed *and* less than this much is left, so small machines block exactly as
 * before and large ones keep admitting while real headroom remains.
 */
const DEFAULT_MIN_AVAILABLE_MB = 2 * MAX_HEAP_MB;
const configuredMinAvailable = Number(process.env.MG_MIN_AVAILABLE_MB ?? DEFAULT_MIN_AVAILABLE_MB);
const MIN_AVAILABLE_MB = Number.isFinite(configuredMinAvailable) && configuredMinAvailable >= 0
  ? configuredMinAvailable
  : DEFAULT_MIN_AVAILABLE_MB;

/**
 * Whether memory pressure should block new sessions.
 * macOS reports memory through a VM/cache model that is too noisy for hard gating,
 * so it warns by default. Windows/Linux keep blocking by default.
 */
const BLOCK_ON_PRESSURE = (process.env.MG_BLOCK_ON_PRESSURE ?? (platform() === "darwin" ? "0" : "1")) !== "0";

/** Watchdog check interval (ms). */
const WATCHDOG_INTERVAL_MS = Number(process.env.MG_WATCHDOG_INTERVAL_MS ?? 30_000);

// ── Idle reclamation ──

/** Smallest session tree worth reclaiming while the system is under pressure (MB). */
const REAP_PRESSURE_FLOOR_MB = Number(process.env.MG_REAP_PRESSURE_FLOOR_MB ?? 512);

/** Idle time a session must reach before pressure may reclaim it (ms). */
const REAP_PRESSURE_GRACE_MS = Number(process.env.MG_REAP_PRESSURE_GRACE_MS ?? DEFAULT_REAP_LIMITS.pressureGraceMs);

/** Idle time after which a session is reclaimed whatever it costs (ms). */
const REAP_IDLE_BACKSTOP_MS = Number(process.env.MG_REAP_IDLE_BACKSTOP_MS ?? DEFAULT_REAP_LIMITS.idleBackstopMs);

/** Configuration for the session reaper's idle rules. */
export function resolveReapLimits(): ReapLimits {
  return {
    cliRssLimitBytes: MAX_HEAP_MB * 1024 * 1024,
    pressureRssFloorBytes: REAP_PRESSURE_FLOOR_MB * 1024 * 1024,
    pressureGraceMs: REAP_PRESSURE_GRACE_MS,
    idleBackstopMs: REAP_IDLE_BACKSTOP_MS,
  };
}

type PressureReading = {
  total: number;
  free: number;
  usage: number;
  /** Usage has crossed the ratio. Worth telling the user; restricts nothing. */
  high: boolean;
  /** High *and* under the available floor, with blocking enabled. Spawns are refused and idle sessions reclaimed. */
  critical: boolean;
};

function readPressure(): PressureReading {
  const total = totalmem();
  const free = availableMemory();
  const usage = (total - free) / total;
  const high = usage >= PRESSURE_THRESHOLD;
  return { total, free, usage, high, critical: BLOCK_ON_PRESSURE && high && free < MIN_AVAILABLE_MB * 1024 * 1024 };
}

/**
 * Whether memory is low enough to reclaim idle sessions: the same rule that
 * refuses spawns. Where the OS reports memory through a model too noisy to gate
 * on, this stays false rather than letting jitter reclaim live sessions.
 */
export function isUnderMemoryPressure(): boolean {
  return readPressure().critical;
}

// ── Largest consumers ──
// Pressure is usually caused by something other than Modus, and a percentage
// alone sends the user looking in the wrong place. While memory is high the
// watchdog samples the process table so refusals and status can name it.

/** How long a sample stays good enough to name in a refusal or status. */
const LARGEST_TTL_MS = 2 * WATCHDOG_INTERVAL_MS + 15_000;

let largest: { at: number; groups: ProcessGroupUsage[] } | null = null;
let largestRefresh: Promise<void> | null = null;

function refreshLargestProcesses(): void {
  if (largestRefresh) return;
  largestRefresh = sampleProcessTable()
    .then((table) => {
      if (table.size > 0) largest = { at: Date.now(), groups: largestProcessGroups(table) };
    })
    .catch(() => {})
    .finally(() => { largestRefresh = null; });
}

function freshLargestProcesses(): ProcessGroupUsage[] {
  return largest && Date.now() - largest.at < LARGEST_TTL_MS ? largest.groups : [];
}

/** `Surfshark 185.0 GB, chrome 6.2 GB (41 processes)`, or "" before any sample. */
export function describeProcessGroups(groups: ProcessGroupUsage[]): string {
  return groups.map((group) => {
    const gb = (group.rssBytes / 1024 / 1024 / 1024).toFixed(1);
    return `${group.name} ${gb} GB${group.count > 1 ? ` (${group.count} processes)` : ""}`;
  }).join(", ");
}

// ── Env injection ──

/**
 * Returns a copy of `env` with `--max-old-space-size` injected into NODE_OPTIONS.
 * Preserves any existing NODE_OPTIONS values. Works with both
 * `Record<string, string>` and `Record<string, string | undefined>` env shapes.
 *
 * This only binds a CLI that runs on Node. A natively compiled provider CLI
 * ignores NODE_OPTIONS entirely — verified against `claude` 2.1.215, which
 * starts successfully with a deliberately invalid flag in NODE_OPTIONS where
 * Node would refuse to start. Those providers are bounded by the reaper's
 * `cliRssLimitBytes` rule instead.
 */
export function getMemoryLimitedEnv<T extends Record<string, string | undefined>>(env: T): T {
  const existing = env.NODE_OPTIONS ?? "";
  // Don't double-inject if already set
  if (existing.includes("--max-old-space-size")) return env;
  const flag = `--max-old-space-size=${MAX_HEAP_MB}`;
  return {
    ...env,
    NODE_OPTIONS: existing ? `${existing} ${flag}` : flag,
  };
}

// ── Pre-spawn guard ──

export type SpawnGuardResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Prefix on errors thrown when the guard refuses a spawn. */
export const SPAWN_REFUSED_PREFIX = "[memory-guard]";

/** Whether an error is a guard refusal, which routes report as 503 with its reason. */
export function isSpawnRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(SPAWN_REFUSED_PREFIX);
}

/**
 * Check whether a new session can be spawned. Returns `{ ok: false, reason }` if:
 * - `activeCount` >= the current concurrency limit
 * - System memory pressure exceeds threshold, less than `MG_MIN_AVAILABLE_MB`
 *   is available, and pressure blocking is enabled
 */
export function canSpawnSession(activeCount: number): SpawnGuardResult {
  if (activeCount >= maxConcurrentSessions) {
    return {
      ok: false,
      reason: `concurrent session limit reached (${activeCount}/${maxConcurrentSessions}). ` +
        `Wait for an existing session to finish or raise the limit in Settings > Environment.`,
    };
  }

  const { total, free, usage, critical } = readPressure();

  if (critical) {
    const usedGB = ((total - free) / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    const culprits = describeProcessGroups(freshLargestProcesses());
    return {
      ok: false,
      reason: `system memory nearly exhausted: ${usedGB}/${totalGB} GB used ` +
        `(${(usage * 100).toFixed(0)}%, under ${(MIN_AVAILABLE_MB / 1024).toFixed(1)} GB available). ` +
        (culprits ? `Largest: ${culprits}. ` : "") +
        `Close what is using it before starting new sessions.`,
    };
  }

  return { ok: true };
}

// ── Memory watchdog ──

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export interface MemoryStatus {
  totalGB: number;
  freeGB: number;
  usedGB: number;
  usagePercent: number;
  pressureThreshold: number;
  pressureBlockingEnabled: boolean;
  minAvailableMB: number;
  /** Usage is past the threshold. */
  highPressure: boolean;
  /** New sessions are being refused for memory right now. */
  spawnBlocked: boolean;
  /** Largest images by resident memory, sampled by the watchdog while pressure is high. */
  largestProcesses: Array<{ name: string; memoryGB: number; count: number }>;
  maxHeapPerProcessMB: number;
  maxConcurrentSessions: number;
  concurrencyLimitMutable: boolean;
  watchdogRunning: boolean;
}

export function getMemoryStatus(): MemoryStatus {
  const { total, free, high, critical } = readPressure();
  return {
    totalGB: +(total / 1024 / 1024 / 1024).toFixed(2),
    freeGB: +(free / 1024 / 1024 / 1024).toFixed(2),
    usedGB: +((total - free) / 1024 / 1024 / 1024).toFixed(2),
    usagePercent: +(((total - free) / total) * 100).toFixed(1),
    pressureThreshold: PRESSURE_THRESHOLD * 100,
    pressureBlockingEnabled: BLOCK_ON_PRESSURE,
    minAvailableMB: MIN_AVAILABLE_MB,
    highPressure: high,
    spawnBlocked: critical,
    largestProcesses: high
      ? freshLargestProcesses().map((group) => ({
        name: group.name,
        memoryGB: +(group.rssBytes / 1024 / 1024 / 1024).toFixed(1),
        count: group.count,
      }))
      : [],
    maxHeapPerProcessMB: MAX_HEAP_MB,
    maxConcurrentSessions,
    concurrencyLimitMutable: true,
    watchdogRunning: watchdogTimer !== null,
  };
}

export function startMemoryWatchdog(): void {
  if (watchdogTimer) return;
  console.log(
    `[memory-guard] watchdog started — heap cap: ${MAX_HEAP_MB}MB/process, ` +
    `max concurrent: ${maxConcurrentSessions}, pressure threshold: ${(PRESSURE_THRESHOLD * 100).toFixed(0)}% ` +
    `below ${MIN_AVAILABLE_MB}MB available, ` +
    `pressure blocking: ${BLOCK_ON_PRESSURE ? "on" : "off"}`
  );
  watchdogTimer = setInterval(() => {
    const { total, free, usage, high, critical } = readPressure();
    const usedGB = ((total - free) / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    const pressureAction = critical ? "new sessions will be blocked" : "new sessions allowed";

    if (high) {
      refreshLargestProcesses();
      const culprits = describeProcessGroups(freshLargestProcesses());
      console.warn(
        `[memory-guard] HIGH PRESSURE: ${usedGB}/${totalGB} GB ` +
        `(${(usage * 100).toFixed(0)}%) - ${pressureAction}` +
        (culprits ? ` - largest: ${culprits}` : "")
      );
    } else if (usage >= 0.75) {
      console.warn(
        `[memory-guard] warning: ${usedGB}/${totalGB} GB (${(usage * 100).toFixed(0)}%)`
      );
    }
  }, WATCHDOG_INTERVAL_MS);
}

export function stopMemoryWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    console.log("[memory-guard] watchdog stopped");
  }
}
