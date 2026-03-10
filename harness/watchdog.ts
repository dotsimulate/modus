/**
 * Modus watchdog — auto-restarts on crash, health-polls, git rollback on bad deploys.
 *
 * Usage:   bun run watch          — crash watchdog only
 *          bun run watch:dev      — crash watchdog + file watcher (auto-reload on .ts changes)
 *
 * Config:  MODUS_NOTIFY_TOPIC=<ntfy-topic>   push notifications on crash (optional)
 *          MODUS_RESTART_DELAY=3000           base restart delay ms (default 3000)
 *          MODUS_WATCH_FILES=1                watch harness/*.ts and restart on changes
 *          MODUS_GIT_ROLLBACK=1              on quick crash, git stash dirty files and retry
 *          HARNESS_PORT=3777                  must match harness (default 3777)
 *
 * Notifications via ntfy.sh — subscribe at https://ntfy.sh/<your-topic>
 * (free, no account needed, iOS/Android/web)
 *
 * Quick crash detection: if modus crashes within 30s of starting, the watchdog
 * assumes a bad deploy and tries `git stash` to roll back local changes before
 * restarting. Delay doubles on each quick crash (3s → 6s → 12s... cap 60s).
 * Runtime crashes (uptime > 30s) reset the delay — likely transient.
 */

import simpleGit from "simple-git";
import { appendFileSync, watch as fsWatch, existsSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { createConnection } from "net";

const HARNESS_DIR = import.meta.dir;
const REPO_DIR = resolve(HARNESS_DIR, "..");
const LOG_FILE = join(HARNESS_DIR, "watchdog.log");
const PORT = Number(process.env.HARNESS_PORT ?? 3777);
const VITE_PORT = 5180;
const BASE_DELAY_MS = Number(process.env.MODUS_RESTART_DELAY ?? 3000);
const MAX_DELAY_MS = 60_000;
const CRASH_LOG_LINES = 50;
const STARTUP_GRACE_MS = 30_000;       // crash within this window = bad deploy
const HEALTH_POLL_INTERVAL_MS = 30_000;
const HEALTH_POLL_TIMEOUT_MS = 5_000;
const HEALTH_POLL_STARTUP_WAIT_MS = 8_000; // wait for harness to bind before polling
const NTFY_TOPIC = process.env.MODUS_NOTIFY_TOPIC ?? "";

const WATCH_FILES = process.env.MODUS_WATCH_FILES === "1";
const GIT_ROLLBACK = process.env.MODUS_GIT_ROLLBACK === "1";
const MAX_LOG_BYTES = 1 * 1024 * 1024; // rotate watchdog.log at 1MB
const HEALTH_FAIL_THRESHOLD = 2;       // consecutive failures before killing

// Exit codes that mean intentional stop — don't restart
const CLEAN_EXITS = new Set([0, 130, 143]); // 0=ok, 130=SIGINT, 143=SIGTERM
const RESTART_SENTINEL = join(HARNESS_DIR, ".watchdog-restart");

let currentProc: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;

/** Kill a process and its entire tree (Windows grandchildren included). */
function killTree(proc: ReturnType<typeof Bun.spawn>) {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" });
    } else {
      proc.kill();
    }
  } catch { /* best effort */ }
}
let healthTimer: ReturnType<typeof setInterval> | null = null;
let fileChangeRestart = false;
let pendingReloadFile: string | null = null;  // file change waiting for sessions to clear
let pendingReloadTimer: ReturnType<typeof setInterval> | null = null;
const PENDING_RELOAD_POLL_MS = 5_000; // check sessions every 5s when reload is pending
const fileWatchers: ReturnType<typeof fsWatch>[] = [];

process.on("SIGINT", () => { stopping = true; teardown(); });
process.on("SIGTERM", () => { stopping = true; teardown(); });

function teardown() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (pendingReloadTimer) { clearInterval(pendingReloadTimer); pendingReloadTimer = null; }
  for (const w of fileWatchers) { try { w.close(); } catch { /* best effort */ } }
  if (currentProc) killTree(currentProc);
}

// ── Logging ──

function log(level: "info" | "warn" | "error", msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [watchdog] [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".old");
    }
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch { /* non-blocking */ }
}

// ── Notifications ──

async function notify(title: string, body: string) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "warning" },
      body,
    });
  } catch (e) {
    log("warn", `push notification failed: ${e}`);
  }
}

// ── Health polling ──

function startHealthPolling(proc: ReturnType<typeof Bun.spawn>) {
  if (healthTimer) clearInterval(healthTimer);

  let failures = 0;
  let inFlight = false;

  healthTimer = setInterval(async () => {
    if (inFlight || currentProc !== proc || stopping) return;
    inFlight = true;
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(HEALTH_POLL_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      failures = 0; // reset on success
    } catch (e) {
      failures++;
      if (failures >= HEALTH_FAIL_THRESHOLD) {
        log("error", `health check failed ${failures}x (${e}) — killing hung process`);
        await notify("Modus hung", `Health check failed ${failures} times: ${e}`);
        killTree(proc);
      } else {
        log("warn", `health check failed (${e}) — ${HEALTH_FAIL_THRESHOLD - failures} more before kill`);
      }
    } finally {
      inFlight = false;
    }
  }, HEALTH_POLL_INTERVAL_MS);
}

// ── Git rollback ──

async function tryGitStash(): Promise<string | null> {
  try {
    const git = simpleGit(REPO_DIR);
    const status = await git.status();
    const dirtyCount = status.modified.length + status.staged.length + status.not_added.length;
    if (dirtyCount === 0) return null;

    await git.stash(["push", "-m", `watchdog-rollback-${Date.now()}`]);
    const hash = (await git.revparse(["HEAD"])).trim().slice(0, 8);
    return `stashed ${dirtyCount} file(s), reverted to ${hash}`;
  } catch (e) {
    log("warn", `git stash failed: ${e}`);
    return null;
  }
}

// ── Port availability check ──

/** Returns true if a TCP connection to port succeeds (port is in use). */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { resolve(false); });
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

/** Wait until a port is free, polling every interval. Returns false on timeout. */
async function waitForPortFree(port: number, timeoutMs = 15_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

// ── File watcher (dev mode) ──

const WATCH_EXTS = new Set([".ts", ".tsx", ".hbs", ".css"]);

/** Check if harness has active sessions via unauthenticated /health endpoint. */
async function getActiveSessionCount(): Promise<number> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json() as { activeSessions?: number };
      return data.activeSessions ?? 0;
    }
  } catch {
    // Harness unreachable — safe to restart
  }
  return 0;
}

/** Execute the pending reload — kill the harness process. */
function executePendingReload() {
  if (pendingReloadTimer) { clearInterval(pendingReloadTimer); pendingReloadTimer = null; }
  if (!currentProc || stopping) { pendingReloadFile = null; return; }
  log("info", `file changed: ${pendingReloadFile} — reloading...`);
  pendingReloadFile = null;
  fileChangeRestart = true;
  killTree(currentProc);
}

/** Start polling for sessions to clear so we can apply a pending reload. */
function startPendingReloadPoll() {
  if (pendingReloadTimer) return; // already polling
  pendingReloadTimer = setInterval(async () => {
    if (!pendingReloadFile || stopping) {
      if (pendingReloadTimer) { clearInterval(pendingReloadTimer); pendingReloadTimer = null; }
      return;
    }
    const count = await getActiveSessionCount();
    if (count === 0) {
      executePendingReload();
    } else {
      log("info", `pending reload (${pendingReloadFile}) — still ${count} active session(s), waiting...`);
    }
  }, PENDING_RELOAD_POLL_MS);
}

function startFileWatcher() {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const triggerReload = (_: string, filename: string | null) => {
    if (!filename) return;
    const ext = filename.slice(filename.lastIndexOf("."));
    if (!WATCH_EXTS.has(ext)) return;
    if (filename === "watchdog.ts") return; // don't self-restart
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (!currentProc || stopping) return;
      const count = await getActiveSessionCount();
      if (count > 0) {
        // Sessions active — queue the reload, poll until they clear
        pendingReloadFile = filename;
        log("warn", `file changed: ${filename} — ${count} active session(s), deferring reload`);
        startPendingReloadPoll();
        return;
      }
      // No sessions — reload immediately
      pendingReloadFile = filename;
      executePendingReload();
    }, 500);
  };

  // Watch harness root
  fileWatchers.push(fsWatch(HARNESS_DIR, triggerReload));

  // Watch prompt subdirectories (non-recursive on Linux — must watch each dir explicitly)
  const promptsDir = join(HARNESS_DIR, "prompts");
  if (existsSync(promptsDir)) {
    for (const entry of readdirSync(promptsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fileWatchers.push(fsWatch(join(promptsDir, entry.name), triggerReload));
      }
    }
  }

  log("info", `file watcher active on ${HARNESS_DIR} (${[...WATCH_EXTS].join(", ")})`);
}

// ── Main loop ──

async function run() {
  let restarts = 0;
  let delay = BASE_DELAY_MS;

  log("info", `watchdog started (port :${PORT}, notify: ${NTFY_TOPIC || "off"}, file-watch: ${WATCH_FILES ? "on" : "off"})`);
  if (WATCH_FILES) startFileWatcher();

  while (!stopping) {
    const startedAt = Date.now();
    const logBuffer: string[] = [];

    log("info", restarts === 0
      ? "starting modus..."
      : `restarting modus (attempt #${restarts}, next delay was ${delay / 1000}s)...`
    );

    const proc = Bun.spawn(["bun", "run", "dev.ts"], {
      cwd: HARNESS_DIR,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
      env: { ...process.env },
    });
    currentProc = proc;

    // Tee stderr: forward to process.stderr + buffer last N lines for crash reports
    (async () => {
      const reader = proc.stderr.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value);
        process.stderr.write(text);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          logBuffer.push(line);
          if (logBuffer.length > CRASH_LOG_LINES) logBuffer.shift();
        }
      }
    })();

    // Start health polling after giving the harness time to bind
    const healthStart = setTimeout(() => {
      if (currentProc === proc && !stopping) startHealthPolling(proc);
    }, HEALTH_POLL_STARTUP_WAIT_MS);

    const code = await proc.exited;
    await Bun.sleep(50); // let stderr reader flush final bytes into logBuffer
    clearTimeout(healthStart);
    currentProc = null;
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    if (pendingReloadTimer) { clearInterval(pendingReloadTimer); pendingReloadTimer = null; }
    pendingReloadFile = null;

    // Controlled restart requested by agent — skip crash logic, wait for port
    if (existsSync(RESTART_SENTINEL)) {
      try { unlinkSync(RESTART_SENTINEL); } catch { /* best effort */ }
      log("info", "controlled restart requested — waiting for ports...");
      await waitForPortFree(VITE_PORT);
      restarts++;
      delay = BASE_DELAY_MS;
      continue;
    }

    // File-change restart — wait for Vite port to actually free up
    if (fileChangeRestart) {
      fileChangeRestart = false;
      restarts++;
      const portFree = await waitForPortFree(VITE_PORT);
      if (!portFree) log("warn", `port ${VITE_PORT} still in use after timeout — restarting anyway`);
      continue;
    }

    if (stopping || (code != null && CLEAN_EXITS.has(code))) break;

    const uptime = Math.round((Date.now() - startedAt) / 1000);
    const quickCrash = (Date.now() - startedAt) < STARTUP_GRACE_MS;
    const snippet = logBuffer.length > 0 ? logBuffer.join("\n") : "(no stderr captured)";

    log("error", `modus crashed — exit ${code}, uptime ${uptime}s${quickCrash ? " [quick crash — bad deploy?]" : ""}`);

    let rollbackNote = "";
    if (quickCrash) {
      if (GIT_ROLLBACK) {
        log("warn", "attempting git stash rollback...");
        const stashMsg = await tryGitStash();
        if (stashMsg) {
          rollbackNote = `\nrolled back: ${stashMsg}`;
          log("info", stashMsg);
        } else {
          log("info", "no local changes to stash");
        }
      }
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    } else {
      delay = BASE_DELAY_MS; // runtime crash — likely transient, reset delay
    }

    await notify(
      `Modus crashed (exit ${code})`,
      `uptime: ${uptime}s | restart #${restarts + 1}${rollbackNote}\n\n--- last logs ---\n${snippet}`,
    );

    restarts++;
    log("info", `restarting in ${delay / 1000}s...`);
    await Bun.sleep(delay);
  }

  log("info", "watchdog stopped.");
}

run();
