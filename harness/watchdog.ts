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
import { appendFileSync, readFileSync, watch as fsWatch, existsSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { createConnection } from "net";
import { createHash } from "crypto";

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

/**
 * Ask the harness to shut itself down gracefully via HTTP.
 * This lets it call server.stop(true), closing all connections and freeing the port.
 * Returns true if the harness acknowledged the shutdown request.
 */
async function requestGracefulShutdown(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/internal/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    return resp.ok;
  } catch { return false; }
}

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

/**
 * Gracefully stop the harness: request shutdown via HTTP first (frees the port cleanly),
 * then wait for the process to exit. Falls back to force-kill if it doesn't respond.
 */
async function gracefulKill(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const acked = await requestGracefulShutdown();
  if (acked) {
    // Wait up to 5s for the process to exit on its own
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      // proc.exitCode is null while running
      if (proc.exitCode !== null) return;
      await Bun.sleep(200);
    }
    log("warn", "graceful shutdown timed out — force killing");
  }
  killTree(proc);
}

/** Names of agent CLI binaries that providers may spawn as subprocesses. */
const AGENT_BINARIES = ["claude", "codex"];

/**
 * Kill orphaned agent subprocesses (claude, codex) that survived the tree kill.
 * The Codex SDK spawns `codex exec` as a child process; Claude Code spawns `claude`.
 * On unclean shutdown these can outlive the harness and block restart.
 */
function killOrphanedAgents() {
  try {
    if (process.platform === "win32") {
      for (const name of AGENT_BINARIES) {
        Bun.spawnSync(["taskkill", "/F", "/IM", `${name}.exe`], { stdout: "ignore", stderr: "ignore" });
      }
    } else {
      // pkill by exact binary name — only kills processes matching these names
      for (const name of AGENT_BINARIES) {
        Bun.spawnSync(["pkill", "-x", name], { stdout: "ignore", stderr: "ignore" });
      }
    }
  } catch { /* best effort */ }
}
let healthTimer: ReturnType<typeof setInterval> | null = null;
let fileChangeRestart = false;
let restarting = false;  // true while restart is in progress — suppresses file watcher
let restartCooldownUntil = 0; // timestamp — ignore file changes until this time
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
async function waitForPortFree(port: number, timeoutMs = 30_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/**
 * On Windows, find the PID listening on a port and force-kill it.
 * This is the only reliable way to free a port held by a zombie bun process.
 */
function killPortHolder(port: number) {
  if (process.platform !== "win32") return;
  try {
    const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`
    ], { stdout: "pipe", stderr: "ignore" });
    const pid = new TextDecoder().decode(result.stdout).trim();
    if (pid && /^\d+$/.test(pid)) {
      log("warn", `killing PID ${pid} holding port ${port}`);
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", pid], { stdout: "ignore", stderr: "ignore" });
    }
  } catch { /* best effort */ }
}

/** Wait for both harness and Vite ports to free up. Kills whatever holds them. Returns true if ports are free. */
async function waitForCleanRestart(): Promise<boolean> {
  // Quick check — ports may already be free
  const [harnessFree, viteFree] = await Promise.all([
    waitForPortFree(PORT, 3_000),
    waitForPortFree(VITE_PORT, 3_000),
  ]);

  if (harnessFree && viteFree) return true;

  // Kill orphaned agent subprocesses (claude, codex)
  killOrphanedAgents();

  // On Windows: directly kill whatever process holds the port
  if (!harnessFree) killPortHolder(PORT);
  if (!viteFree) killPortHolder(VITE_PORT);

  // Wait for ports to actually free after kills
  const [h, v] = await Promise.all([
    !harnessFree ? waitForPortFree(PORT, 15_000, 500) : Promise.resolve(true),
    !viteFree ? waitForPortFree(VITE_PORT, 15_000, 500) : Promise.resolve(true),
  ]);

  if (!h || !v) {
    const stuck = [!h && PORT, !v && VITE_PORT].filter(Boolean);
    log("error", `port(s) ${stuck.join(", ")} still held after kill — NOT launching (would EADDRINUSE)`);
    // Try one more aggressive kill round
    if (!h) killPortHolder(PORT);
    if (!v) killPortHolder(VITE_PORT);
    return false;
  }
  return true;
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

/** Execute the pending reload — gracefully shut down the harness process. */
async function executePendingReload() {
  if (pendingReloadTimer) { clearInterval(pendingReloadTimer); pendingReloadTimer = null; }
  if (!currentProc || stopping) { pendingReloadFile = null; return; }
  log("info", `file changed: ${pendingReloadFile} — reloading...`);
  pendingReloadFile = null;
  fileChangeRestart = true;
  restarting = true;
  await gracefulKill(currentProc);
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
  const hashCache = new Map<string, string>(); // track last-seen content hash per file

  /** Check if a file's content actually changed since we last saw it (hash-based, immune to Windows mtime noise). */
  function fileActuallyChanged(filename: string): boolean {
    try {
      const filepath = join(HARNESS_DIR, filename);
      const content = readFileSync(filepath);
      const hash = createHash("md5").update(content).digest("hex");
      const prev = hashCache.get(filename);
      hashCache.set(filename, hash);
      if (prev === undefined) {
        log("info", `[hash] ${filename} — first seen, seeding cache (${hash.slice(0, 8)}), ignoring`);
        return false;
      }
      if (hash === prev) {
        log("info", `[hash] ${filename} — content unchanged (${hash.slice(0, 8)}), ignoring`);
        return false;
      }
      log("info", `[hash] ${filename} — content CHANGED (${prev.slice(0, 8)} → ${hash.slice(0, 8)})`);
      return true;
    } catch (e) {
      log("warn", `[hash] ${filename} — read failed: ${e}, ignoring`);
      return false;
    }
  }

  const triggerReload = (_: string, filename: string | null) => {
    if (!filename) return;
    const ext = filename.slice(filename.lastIndexOf("."));
    if (!WATCH_EXTS.has(ext)) return;
    if (filename === "watchdog.ts") return; // don't self-restart
    if (restarting) return; // suppress file events during restart
    if (Date.now() < restartCooldownUntil) return; // post-restart cooldown
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (!currentProc || stopping || restarting || Date.now() < restartCooldownUntil) return;
      // On Windows, fs.watch fires on access — verify file actually changed
      if (!fileActuallyChanged(filename)) return;
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
    }, process.platform === "win32" ? 2000 : 500);
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

  // Ensure ports are free before first launch (zombie from previous run)
  if (await isPortInUse(PORT) || await isPortInUse(VITE_PORT)) {
    log("warn", "port(s) still held from previous run — cleaning up...");
    if (!await waitForCleanRestart()) {
      log("error", "could not free ports for first launch — waiting 10s and retrying...");
      await Bun.sleep(10_000);
      if (!await waitForCleanRestart()) {
        log("error", "ports still stuck after retry — exiting");
        process.exit(1);
      }
    }
  }

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
    restarting = false; // new process spawned — re-enable file watcher
    restartCooldownUntil = Date.now() + 15_000; // ignore ghost file events for 15s after restart

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

    // Controlled restart requested by agent — skip crash logic, wait for ports
    if (existsSync(RESTART_SENTINEL)) {
      try { unlinkSync(RESTART_SENTINEL); } catch { /* best effort */ }
      log("info", "controlled restart requested — waiting for ports...");
      if (!await waitForCleanRestart()) {
        log("warn", "ports not free after controlled restart kill — retrying in 5s...");
        await Bun.sleep(5_000);
        await waitForCleanRestart(); // best effort second try
      }
      restarts++;
      delay = BASE_DELAY_MS;
      continue;
    }

    // File-change restart — wait for harness + Vite ports to free up
    if (fileChangeRestart) {
      fileChangeRestart = false;
      restarts++;
      if (!await waitForCleanRestart()) {
        log("warn", "ports not free after file-change kill — retrying in 5s...");
        await Bun.sleep(5_000);
        await waitForCleanRestart(); // best effort second try
      }
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
    // Kill orphaned agent subprocesses — crash means SIGTERM handler may not have run
    killOrphanedAgents();
    log("info", `restarting in ${delay / 1000}s...`);
    await Bun.sleep(delay);
  }

  log("info", "watchdog stopped.");
}

run();
