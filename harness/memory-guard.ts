/**
 * Memory Guard — prevents OOM system crashes from unbounded agent processes.
 *
 * Incident context (2026-04-12): Three Claude Code CLI node.exe processes consumed
 * ~45 GB RAM collectively, exhausted Windows virtual memory, crashed dwm.exe, and
 * caused cascading failures that destroyed files across multiple directories.
 *
 * This module provides:
 * - V8 heap caps via NODE_OPTIONS injection on spawned processes
 * - Concurrent session limits with system memory pressure checks
 * - Periodic memory watchdog with warnings and optional spawn blocking
 */

import { execFileSync } from "child_process";
import { freemem, totalmem, platform } from "os";
import { readFileSync } from "fs";

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

/** Max V8 heap per spawned agent process (MB). Crashes the process instead of eating the OS. */
const MAX_HEAP_MB = Number(process.env.MG_MAX_HEAP_MB ?? 4096);

/** Max concurrent agent sessions. N × MAX_HEAP_MB = worst-case RAM. */
const MAX_CONCURRENT = Number(process.env.MG_MAX_CONCURRENT ?? 6);

/** Block new sessions when system memory usage exceeds this ratio (0-1). */
const PRESSURE_THRESHOLD = Number(process.env.MG_PRESSURE_THRESHOLD ?? 0.90);

/**
 * Whether memory pressure should block new sessions.
 * macOS reports memory through a VM/cache model that is too noisy for hard gating,
 * so it warns by default. Windows/Linux keep blocking by default.
 */
const BLOCK_ON_PRESSURE = (process.env.MG_BLOCK_ON_PRESSURE ?? (platform() === "darwin" ? "0" : "1")) !== "0";

/** Watchdog check interval (ms). */
const WATCHDOG_INTERVAL_MS = Number(process.env.MG_WATCHDOG_INTERVAL_MS ?? 30_000);

// ── Env injection ──

/**
 * Returns a copy of `env` with `--max-old-space-size` injected into NODE_OPTIONS.
 * Preserves any existing NODE_OPTIONS values. Works with both
 * `Record<string, string>` and `Record<string, string | undefined>` env shapes.
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

/**
 * Check whether a new session can be spawned. Returns `{ ok: false, reason }` if:
 * - `activeCount` >= MAX_CONCURRENT
 * - System memory pressure exceeds threshold and pressure blocking is enabled
 */
export function canSpawnSession(activeCount: number): SpawnGuardResult {
  if (activeCount >= MAX_CONCURRENT) {
    return {
      ok: false,
      reason: `concurrent session limit reached (${activeCount}/${MAX_CONCURRENT}). ` +
        `Wait for an existing session to finish or increase MG_MAX_CONCURRENT.`,
    };
  }

  const total = totalmem();
  const free = availableMemory();
  const usage = (total - free) / total;

  if (BLOCK_ON_PRESSURE && usage >= PRESSURE_THRESHOLD) {
    const usedGB = ((total - free) / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      reason: `system memory pressure too high: ${usedGB}/${totalGB} GB ` +
        `(${(usage * 100).toFixed(0)}% used, threshold ${(PRESSURE_THRESHOLD * 100).toFixed(0)}%). ` +
        `Free memory or stop sessions before starting new ones.`,
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
  maxHeapPerProcessMB: number;
  maxConcurrentSessions: number;
  watchdogRunning: boolean;
}

export function getMemoryStatus(): MemoryStatus {
  const total = totalmem();
  const free = availableMemory();
  return {
    totalGB: +(total / 1024 / 1024 / 1024).toFixed(2),
    freeGB: +(free / 1024 / 1024 / 1024).toFixed(2),
    usedGB: +((total - free) / 1024 / 1024 / 1024).toFixed(2),
    usagePercent: +(((total - free) / total) * 100).toFixed(1),
    pressureThreshold: PRESSURE_THRESHOLD * 100,
    pressureBlockingEnabled: BLOCK_ON_PRESSURE,
    maxHeapPerProcessMB: MAX_HEAP_MB,
    maxConcurrentSessions: MAX_CONCURRENT,
    watchdogRunning: watchdogTimer !== null,
  };
}

export function startMemoryWatchdog(): void {
  if (watchdogTimer) return;
  console.log(
    `[memory-guard] watchdog started — heap cap: ${MAX_HEAP_MB}MB/process, ` +
    `max concurrent: ${MAX_CONCURRENT}, pressure threshold: ${(PRESSURE_THRESHOLD * 100).toFixed(0)}%, ` +
    `pressure blocking: ${BLOCK_ON_PRESSURE ? "on" : "off"}`
  );
  watchdogTimer = setInterval(() => {
    const total = totalmem();
    const free = availableMemory();
    const usage = (total - free) / total;
    const usedGB = ((total - free) / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    const pressureAction = BLOCK_ON_PRESSURE ? "new sessions will be blocked" : "new sessions allowed";

    if (usage >= PRESSURE_THRESHOLD) {
      console.warn(
        `[memory-guard] HIGH PRESSURE: ${usedGB}/${totalGB} GB ` +
        `(${(usage * 100).toFixed(0)}%) - ${pressureAction}`
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
