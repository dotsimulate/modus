#!/usr/bin/env bun
/**
 * Modus CLI — unified entry point for all modus commands.
 *
 * Usage: bun run cli.ts <command> [options]
 *
 * Commands:
 *   start       Start the harness server (foreground by default)
 *   stop        Stop a running daemon
 *   status      Show server status
 *   remote      Manage tailnet exposure via tailscale serve (on|off|status)
 *   init [path] Initialize a .modus/ project
 *   open [path] Init + start + open browser to project
 *   moves export [path] Create a portable zip of project-local moves
 *   setup       Install dependencies and build UI
 *   dev         Dev mode (harness + vite + file watchers)
 *   logs        Tail server output
 *   update      Pull latest + re-setup + restart
 *   maintenance Inspect or apply plan-bound checkpoint storage maintenance
 *   --version   Print version
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
import { networkInterfaces, hostname } from "os";
import { resolve, join, dirname, basename } from "path";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  statSync, readdirSync, unlinkSync, openSync,
} from "fs";
import { createServer } from "net";
import { spawnSync } from "child_process";
import {
  canAdoptLegacyRule,
  classifyHttps443,
  ownershipFor,
  parseOwnership,
  tailscaleServeOffArgs,
  tailscaleServeOnArgs,
} from "./tailscale-serve";
import { formatTokenForBanner } from "./token-display";

// ── Tailscale Serve ──
//
// Remote access is opt-in: `modus remote on` persists it, `modus start --remote`
// enables it for one run. Modus only ever manages a single HTTPS:443 root-path
// proxy to its own local port. It classifies and mutates the :443 endpoint
// alone — rules on any other port (belonging to other apps, or stale/dead) are
// left completely untouched, and teardown removes only modus's own :443 rule
// via `--https=443 off`, never `serve reset` (which would wipe everything).

type TailscaleServeSetup = {
  remoteUrl: string | null;
  error: string | null;
  skipped: string | null;
};

function tailscaleInstalled(): boolean {
  try {
    const res = spawnSync("tailscale", ["version"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
    });
    return res.status === 0;
  } catch { return false; }
}

/**
 * Classify the machine's HTTPS:443 serve endpoint — the only thing modus
 * manages. Rules on any other port are ignored entirely (never inspected,
 * never touched), so modus coexists with unrelated serve rules and is
 * unbothered by stale/dead ones left over from earlier experiments.
 *   "none"    — no :443 web rule (safe to create ours, whatever else exists)
 *   "modus"   — :443 root proxy to a local modus port (ours to replace)
 *   "foreign" — :443 owned by something else (other target/paths/funnel) — never touch
 */
function classifyServeConfig(): "none" | "modus" | "foreign" {
  const res = spawnSync("tailscale", ["serve", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  if (res.status !== 0) {
    const err = (res.stderr?.toString() ?? "").toLowerCase();
    // Some versions exit non-zero when nothing is served
    if (err.includes("no serve config")) return "none";
    return "foreign"; // could not read config — be conservative, don't touch :443
  }
  const raw = res.stdout.toString().trim();
  if (!raw || raw === "{}" || raw === "null") return "none";
  let cfg: any;
  try { cfg = JSON.parse(raw); } catch { return "foreign"; }
  if (!cfg || Object.keys(cfg).length === 0) return "none";

  // Inspect ONLY the :443 web endpoint. Rules on other ports are none of our
  // business — modus never reads or mutates them.
  const web = cfg.Web ?? {};
  const key443 = Object.keys(web).find((k) => k.endsWith(":443"));
  if (!key443) return "none"; // no :443 rule → safe to create ours

  // Funnel exposes the endpoint to the public internet, which modus never
  // configures — so this rule belongs to another tool and must not be touched.
  if (cfg.AllowFunnel?.[key443]) return "foreign";

  const handlers = web[key443]?.Handlers ?? {};
  const paths = Object.keys(handlers);
  if (paths.length !== 1 || paths[0] !== "/") return "foreign";
  const proxy: string = handlers["/"]?.Proxy ?? "";
  const m = proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/);
  if (!m) return "foreign";
  // A prior modus run may have rotated within the ghost-port scan range.
  const modusPorts = new Set<number>();
  for (let offset = 0; offset < PORT_SCAN_RANGE; offset++) modusPorts.add(BASE_PORT + offset);
  return modusPorts.has(Number(m[1])) ? "modus" : "foreign";
}

function readTailscaleOwnership() {
  try { return parseOwnership(readFileSync(TAILSCALE_OWNERSHIP_FILE, "utf-8")); } catch { return null; }
}

function writeTailscaleOwnership(dnsName: string, port: number): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TAILSCALE_OWNERSHIP_FILE, JSON.stringify(ownershipFor(dnsName, port, new Date(), "cli"), null, 2), "utf-8");
}

function serveConfigJson(): string | null {
  const res = spawnSync("tailscale", ["serve", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  if (res.status !== 0) {
    const err = (res.stderr?.toString() ?? "").toLowerCase();
    if (err.includes("no serve config")) return "{}";
    return null;
  }
  return res.stdout.toString().trim() || "{}";
}

function classifyOwnedServeConfig(): "none" | "modus" | "foreign" {
  const raw = serveConfigJson();
  return raw == null ? "foreign" : classifyHttps443(raw, readTailscaleOwnership());
}

function setupTailscaleServe(port: number): TailscaleServeSetup {
  // Right after a reboot the tailscale backend can lag behind modus; `status`
  // exits non-zero until it finishes coming up. Retry briefly so a cold-start
  // race doesn't silently disable remote access for the whole session.
  let status = spawnSync("tailscale", ["status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  for (let attempt = 0; attempt < 5 && status.status !== 0; attempt++) {
    Bun.sleepSync(1000);
    status = spawnSync("tailscale", ["status", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
  }
  if (status.status !== 0) {
    return { remoteUrl: null, error: null, skipped: "tailscale is not running — start it, then restart modus" };
  }

  try {
    const payload = JSON.parse(status.stdout.toString());
    const dnsName = payload?.Self?.DNSName?.replace(/\.$/, "") ?? null;
    const remoteUrl = dnsName ? `https://${dnsName}` : null;

    const rawConfig = serveConfigJson();
    if (rawConfig == null) {
      return { remoteUrl: null, error: null, skipped: "could not read tailscale serve configuration — leaving it untouched" };
    }
    let owner = classifyHttps443(rawConfig, readTailscaleOwnership());
    if (owner === "foreign" && !readTailscaleOwnership() && canAdoptLegacyRule(
      rawConfig, port, existsSync(REMOTE_FILE), BASE_PORT, PORT_SCAN_RANGE,
    ) && dnsName) {
      // One-time migration for the pre-ownership Modus rule. Persisted remote
      // opt-in plus an exact current target are both required.
      writeTailscaleOwnership(dnsName, port);
      owner = classifyHttps443(rawConfig, readTailscaleOwnership());
    }
    const recordedOwner = readTailscaleOwnership();
    if (owner === "modus" && recordedOwner?.managedBy === "desktop") {
      return {
        remoteUrl,
        error: null,
        skipped: "the desktop-managed backend currently owns the Modus Tailscale route — leaving it untouched",
      };
    }
    if (owner === "foreign") {
      return {
        remoteUrl: null,
        error: null,
        skipped: `tailscale serve is already used by another service — leaving it untouched.\n           To expose modus manually: tailscale serve --bg ${port}`,
      };
    }

    // Empty or modus-owned config — set/replace our rule in place.
    // --yes answers the interactive replace prompt non-interactively.
    const serve = spawnSync("tailscale", tailscaleServeOnArgs(port), {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    if (serve.status !== 0) {
      const details = serve.stderr?.toString().trim() || serve.stdout?.toString().trim() || "tailscale serve failed";
      console.error(`[tailscale] serve --bg ${port} failed:`, details);
      return { remoteUrl, error: details, skipped: null };
    }

    if (dnsName) writeTailscaleOwnership(dnsName, port);
    console.log(`[tailscale] serve --bg ${port} ok → ${remoteUrl ?? "(no DNS name)"}`);
    return { remoteUrl, error: null, skipped: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to parse tailscale status";
    console.error(`[tailscale] setup error:`, msg);
    return { remoteUrl: null, error: msg, skipped: null };
  }
}

/**
 * Remove modus's own serve rule — only the :443 endpoint, via `--https=443 off`.
 * Never `serve reset` (which would wipe unrelated rules on other ports). Acts
 * only when :443 is modus-owned. Returns true if the rule was removed.
 */
function clearTailscaleServe(allowDesktopOwner = false): boolean {
  try {
    const raw = serveConfigJson();
    if (raw == null) return false;
    const owner = readTailscaleOwnership();
    if (owner?.managedBy === "desktop" && !allowDesktopOwner) return false;
    const classification = classifyHttps443(raw, owner);
    if (classification === "none" && owner) {
      try { unlinkSync(TAILSCALE_OWNERSHIP_FILE); } catch {}
      return false;
    }
    if (classification !== "modus") return false;
    const res = spawnSync("tailscale", tailscaleServeOffArgs(), {
      stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
    if (res.status === 0) {
      try { unlinkSync(TAILSCALE_OWNERSHIP_FILE); } catch {}
      return true;
    }
    return false;
  } catch { return false; }
}

/** Remote access resolution: --remote / --no-remote override the persisted setting. */
function remoteEnabled(args: string[]): boolean {
  if (hasFlag(args, "--no-remote")) return false;
  if (hasFlag(args, "--remote")) return true;
  try { return readFileSync(REMOTE_FILE, "utf-8").trim() === "tailscale"; } catch { return false; }
}

/** Best-effort check for a configured browser PIN (secrets file or env). */
function pinConfigured(): boolean {
  if (process.env.HARNESS_PIN) return true;
  try {
    const path = process.env.HARNESS_SECRETS_FILE ?? join(CONFIG_DIR, "secrets.env");
    return /^\s*HARNESS_PIN\s*=\s*\S/m.test(readFileSync(path, "utf-8"));
  } catch { return false; }
}

// ── Paths ──

const HARNESS_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(HARNESS_DIR, "..");
const UI_DIR = join(HARNESS_DIR, "ui");
const UI_SRC_DIR = join(UI_DIR, "src");
const UI_DIST_DIR = join(UI_DIR, "dist");
const BUN = process.execPath;
const CLI_PATH = Bun.fileURLToPath(import.meta.url);

const CONFIG_DIR = join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".config", "agent-dev-zone",
);
const TOKEN_FILE = join(CONFIG_DIR, "harness-token");
const PID_FILE = join(CONFIG_DIR, "harness.pid");
const PORT_FILE = join(CONFIG_DIR, "harness.port");
const REMOTE_FILE = join(CONFIG_DIR, "remote");
const TAILSCALE_OWNERSHIP_FILE = join(CONFIG_DIR, "tailscale-serve-owner.json");
const LOG_FILE = join(HARNESS_DIR, "harness.log");
const UI_DEPS_STAMP = join(UI_DIR, ".modus-deps.stamp");

const BASE_PORT = Number(process.env.HARNESS_PORT ?? 3777);
// Ghost-port rotation range, shared by cmdStart and the tailscale serve
// ownership check (a prior run may have served a rotated port).
const PORT_SCAN_RANGE = 5;

// ── Helpers ──

function loadVersion(): { version: string; channel: string } {
  try {
    return JSON.parse(readFileSync(join(HARNESS_DIR, "version.json"), "utf-8"));
  } catch {
    return { version: "unknown", channel: "dev" };
  }
}

function loadToken(): { token: string; source: string } {
  // env > disk > generate
  if (process.env.HARNESS_TOKEN) {
    return { token: process.env.HARNESS_TOKEN, source: "env" };
  }
  try {
    if (existsSync(TOKEN_FILE)) {
      const token = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (token) return { token, source: "persisted" };
    }
  } catch { /* fall through */ }

  const token = randomBytes(16).toString("hex");
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, "utf-8");
    return { token, source: "persisted" };
  } catch {
    return { token, source: "generated" };
  }
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => { srv.close(() => res(true)); });
    srv.listen(port, "127.0.0.1");
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) return true;
    } catch { /* not ready yet */ }
    await Bun.sleep(300);
  }
  return false;
}

async function requestGracefulShutdown(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/internal/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    return resp.ok;
  } catch { return false; }
}

/**
 * POSIX has no `taskkill /T`. Signalling a bare pid reaches only that process, so the
 * provider CLIs the backend spawned survive as orphans reparented to init — the
 * ghost-process failure this project keeps hitting. A negative pid signals the whole
 * process group instead, which is safe only when the target is a group leader: the
 * processes below are spawned `detached` precisely so that holds (pgid === pid).
 * Falls back to the bare pid when no such group exists, which is what the old code did.
 */
function signalGroup(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already dead */ }
  }
}

function killTree(proc: Subprocess): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
        stdout: "ignore", stderr: "ignore",
      });
    } else {
      signalGroup(proc.pid, "SIGTERM");
    }
  } catch { /* best effort */ }
}

/**
 * SIGTERM the tree, then SIGKILL anything still alive. Windows needs no escalation —
 * `taskkill /F` is already forceful — so this only adds a second stage on POSIX.
 */
async function killTreeAndWait(proc: Subprocess, graceMs = 3_000): Promise<void> {
  killTree(proc);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return;
    await Bun.sleep(100);
  }
  if (proc.exitCode === null && process.platform !== "win32") {
    signalGroup(proc.pid, "SIGKILL");
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], {
        stdout: "ignore", stderr: "ignore",
      });
    } else {
      signalGroup(pid, "SIGTERM");
    }
  } catch { /* process may already be dead */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function readPortFile(): number | null {
  try {
    const raw = readFileSync(PORT_FILE, "utf-8").trim();
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  } catch { return null; }
}

function writeStateFiles(pid: number, port: number): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), "utf-8");
  writeFileSync(PORT_FILE, String(port), "utf-8");
}

function cleanStateFiles(): void {
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
  try { unlinkSync(PORT_FILE); } catch { /* already gone */ }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch { /* non-critical */ }
}

function getLanIp(): string | undefined {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
}

function uiBuildStale(): boolean {
  if (!existsSync(UI_DIST_DIR)) return true;
  if (!existsSync(UI_SRC_DIR)) return false;

  function latestMtime(dir: string): number {
    let latest = 0;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".cache") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          latest = Math.max(latest, latestMtime(full));
        } else {
          try { latest = Math.max(latest, statSync(full).mtimeMs); } catch { /* skip */ }
        }
      }
    } catch { /* unreadable dir */ }
    return latest;
  }

  const srcTime = latestMtime(UI_SRC_DIR);
  const distTime = latestMtime(UI_DIST_DIR);
  return srcTime > distTime;
}

function uiDepsStale(): boolean {
  const pkgJson = join(UI_DIR, "package.json");
  const lockFile = join(UI_DIR, "bun.lock");
  const nmDir = join(UI_DIR, "node_modules");
  if (!existsSync(nmDir)) return true;
  try {
    const stampTime = existsSync(UI_DEPS_STAMP) ? statSync(UI_DEPS_STAMP).mtimeMs : 0;
    const pkgTime = existsSync(pkgJson) ? statSync(pkgJson).mtimeMs : 0;
    const lockTime = existsSync(lockFile) ? statSync(lockFile).mtimeMs : 0;
    if (stampTime === 0) {
      writeFileSync(UI_DEPS_STAMP, new Date().toISOString(), "utf-8");
      return false;
    }
    return Math.max(pkgTime, lockTime) > stampTime;
  } catch { return true; }
}

function installUiDeps(): boolean {
  console.log("Installing UI dependencies...");
  const result = Bun.spawnSync([BUN, "install"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error("UI dependency install failed.");
    return false;
  }
  try { writeFileSync(UI_DEPS_STAMP, new Date().toISOString(), "utf-8"); } catch { /* non-critical */ }
  return true;
}

function buildUi(): boolean {
  console.log("Building UI...");
  const result = Bun.spawnSync([BUN, "run", "build"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error("UI build failed.");
    return false;
  }
  console.log("UI build complete.");
  return true;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function getArg(args: string[], index: number): string | undefined {
  const val = args[index];
  if (val && !val.startsWith("-")) return val;
  return undefined;
}

function getFlagValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (!flags.includes(args[i]!)) continue;
    const next = args[i + 1];
    if (next && !next.startsWith("-")) return next;
  }
  return undefined;
}

function getPositionalArgs(args: string[], flagsWithValues: string[] = []): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      if (flagsWithValues.includes(arg)) i += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

// ── Commands ──

async function cmdDaemonSupervise(): Promise<void> {
  // Deliberately NOT detached: this supervisor is itself a group leader (spawned
  // detached by cmdStart), and keeping the backend and its providers inside that same
  // group is what lets `modus stop` reap the whole daemon with one group signal.
  const child = spawn([BUN, "run", "index.ts"], {
    cwd: HARNESS_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  let stopping = false;
  const stopChild = () => {
    if (stopping) return;
    stopping = true;
    // Fire-and-forget: the escalation timer runs while we await child.exited below.
    void killTreeAndWait(child);
  };
  process.on("SIGINT", stopChild);
  process.on("SIGTERM", stopChild);
  const code = await child.exited;
  clearTailscaleServe();
  process.exit(code ?? 1);
}

async function cmdStart(args: string[]): Promise<void> {
  const daemon = hasFlag(args, "-d", "--daemon");

  // Check if already running
  const existingPid = readPidFile();
  if (existingPid && isPidAlive(existingPid)) {
    const port = readPortFile() ?? BASE_PORT;
    console.log(`Modus is already running (pid ${existingPid}, port ${port})`);
    console.log(`  http://localhost:${port}`);
    return;
  }
  // Stale PID file — clean it
  if (existingPid) cleanStateFiles();

  // Install UI deps if needed, then build
  if (uiDepsStale()) {
    if (!installUiDeps()) {
      process.exit(1);
    }
  }
  if (uiBuildStale()) {
    if (!buildUi()) {
      process.exit(1);
    }
  }

  // Check port — if something is listening, try a health check to distinguish
  // a live modus instance from orphaned TCP state left by a dead process.
  let usePort = BASE_PORT;
  if (!(await canBindPort(BASE_PORT))) {
    const alive = await waitForHealth(BASE_PORT, 2_000).catch(() => false);
    if (alive) {
      console.error(`Port ${BASE_PORT} is in use by a running modus instance. Stop it first or set HARNESS_PORT.`);
      process.exit(1);
    }
    // Ghost socket — scan for a free port nearby (same strategy as watchdog.ts)
    console.log(`Port ${BASE_PORT} has orphaned TCP state from a dead process.`);
    let found = false;
    for (let offset = 1; offset < PORT_SCAN_RANGE; offset++) {
      const candidate = BASE_PORT + offset;
      if (await canBindPort(candidate)) {
        usePort = candidate;
        found = true;
        console.log(`Rotating to port ${usePort} (will return to ${BASE_PORT} when ghost clears).`);
        break;
      }
    }
    if (!found) {
      console.error(`Ports ${BASE_PORT}–${BASE_PORT + PORT_SCAN_RANGE - 1} all unavailable.`);
      process.exit(1);
    }
  }

  // Migrate legacy source-tree databases before the backend imports any DB
  // module. The migration copies, integrity-checks, and retains each source as
  // a backup; it never merges two independently existing databases.
  if (!process.env.MODUS_DATA_DIR?.trim() && !process.env.MODUS_INSTANCE?.trim()) {
    const { applyStorageMigration, planStorageMigration } = await import("./storage-migration");
    const storagePlan = planStorageMigration();
    if (storagePlan.conflicts > 0) {
      console.error("Storage migration cannot continue because legacy and user-level databases both exist.");
      console.error("Run: modus maintenance storage --dry-run");
      process.exit(1);
    }
    if (storagePlan.migrationCount > 0) {
      console.log(`Migrating ${storagePlan.migrationCount} legacy database(s) to ${storagePlan.locations.dataDir}...`);
      try {
        applyStorageMigration({
          expectedPlanId: storagePlan.planId,
          locations: storagePlan.locations,
          onProgress: (message) => console.log(`  ${message}`),
        });
        console.log("Storage migration verified. Legacy database files were retained as backups.");
      } catch (error) {
        console.error(`Storage migration failed: ${error instanceof Error ? error.message : String(error)}`);
        console.error("The legacy databases were retained and the server was not started.");
        process.exit(1);
      }
    }
  }

  // Token
  const { token, source: tokenSource } = loadToken();
  const revealToken = hasFlag(args, "--show-token");
  const remote = remoteEnabled(args);
  if (!remote) clearTailscaleServe();

  // Clear nested-session guard
  delete process.env.CLAUDECODE;

  const env = {
    ...process.env,
    HARNESS_PORT: String(usePort),
    HARNESS_TOKEN: token,
  };

  if (daemon) {
    // ── Daemon mode ──
    const logFd = openSync(LOG_FILE, "a");
    const proc = spawn([BUN, "run", CLI_PATH, "__daemon-supervise"], {
      cwd: HARNESS_DIR,
      stdout: logFd,
      stderr: logFd,
      env,
      detached: true,
      windowsHide: true,
    });

    // Detach: unref so CLI can exit while child runs
    proc.unref();
    writeStateFiles(proc.pid, usePort);

    console.log("Starting modus daemon...");
    const healthy = await waitForHealth(usePort);
    if (!healthy) {
      console.error("Server did not become healthy within 15s. Check logs: modus logs");
      killPid(proc.pid);
      clearTailscaleServe();
      cleanStateFiles();
      process.exit(1);
    }

    const lanIp = getLanIp();
    const ts = remote ? setupTailscaleServe(usePort) : null;
    console.log(`Modus running (pid ${proc.pid})`);
    console.log(`  http://localhost:${usePort}`);
    if (lanIp) console.log(`  http://${lanIp}:${usePort}`);
    if (ts?.remoteUrl && !ts.error && !ts.skipped) console.log(`  remote  ${ts.remoteUrl}`);
    if (ts?.skipped) console.log(`  tailscale: ${ts.skipped}`);
    if (ts?.error) console.log(`  tailscale: ${ts.error}`);
    if (ts?.remoteUrl && !ts.error && !ts.skipped && !pinConfigured()) {
      console.log(`  note: no browser PIN is set — anyone on your tailnet can open modus`);
    }
    if (!remote && tailscaleInstalled()) {
      console.log(`  remote access off — enable with: modus remote on`);
    }
    console.log(`  token: ${formatTokenForBanner(token, tokenSource, revealToken)}`);
    console.log(`  logs:  modus logs`);

    const cwdParam = process.env.AGENT_CWD
      ? `?cwd=${encodeURIComponent(process.env.AGENT_CWD)}`
      : "";
    openBrowser(`http://localhost:${usePort}${cwdParam}`);
    return;
  }

  // ── Foreground mode ──
  // Detached on POSIX so the backend leads its own process group and killTree can
  // reap the provider CLIs beneath it. Ctrl-C then reaches only this CLI, which is
  // what we want: shutdown() below drives the graceful HTTP path and force-kills the
  // group as a fallback. Windows is left alone — taskkill /T already walks the tree.
  const proc = spawn([BUN, "run", "index.ts"], {
    cwd: HARNESS_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env,
    detached: process.platform !== "win32",
  });

  writeStateFiles(proc.pid, usePort);

  let stopping = false;
  let remoteActive = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down...");

    if (remoteActive) clearTailscaleServe();

    const acked = await requestGracefulShutdown(usePort);
    if (acked) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) break;
        await Bun.sleep(200);
      }
    }

    if (proc.exitCode === null) {
      await killTreeAndWait(proc);
    }

    cleanStateFiles();
  }

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  // Wait for health, then print info and open browser. Cold Windows boots can
  // spend longer than the default 15s inside startup rehydration/indexing; if
  // this one-shot wait times out, the server keeps running but the user never
  // sees the ready URLs. Give foreground starts a wider window and make the
  // wait visible.
  const healthWait = waitForHealth(usePort, 60_000);
  const waitNotice = setTimeout(() => {
    console.log(`Waiting for Modus to finish cold start on port ${usePort}...`);
  }, 5_000);
  const healthy = await healthWait;
  clearTimeout(waitNotice);
  const bound = !(await canBindPort(usePort));
  const processStillRunning = proc.exitCode === null;
  const readyEnough = healthy || (processStillRunning && bound);

  if (readyEnough) {
    if (!healthy) {
      console.warn(`Modus bound port ${usePort}, but /health did not respond within 60s.`);
      console.warn("Continuing startup display anyway; the browser may need a refresh after cold initialization finishes.");
    }
    const lanIp = getLanIp();
    const host = hostname();
    const ts = remote ? setupTailscaleServe(usePort) : null;
    remoteActive = Boolean(ts && ts.remoteUrl && !ts.error && !ts.skipped);
    console.log("");
    console.log(`  modus   http://localhost:${usePort}`);
    if (lanIp) {
      console.log(`  lan     http://${lanIp}:${usePort}`);
      console.log(`          http://${host}.local:${usePort}`);
    }
    if (remoteActive) console.log(`  remote  ${ts!.remoteUrl}`);
    if (ts?.skipped) {
      console.log("");
      console.log(`  tailscale: ${ts.skipped}`);
    }
    if (ts?.error) {
      console.log("");
      console.log("  tailscale serve setup failed:");
      console.log(`           ${ts.error}`);
    }
    if (remoteActive && !pinConfigured()) {
      console.log(`  note    no browser PIN is set — anyone on your tailnet can open modus`);
    }
    if (!remote && tailscaleInstalled()) {
      console.log(`  remote  off — enable with: modus remote on`);
    }
    console.log(`  token   ${formatTokenForBanner(token, tokenSource, revealToken)}`);
    console.log("");
    console.log("  ctrl+c to stop");
    console.log("");
    const cwdParam = process.env.AGENT_CWD
      ? `?cwd=${encodeURIComponent(process.env.AGENT_CWD)}`
      : "";
    openBrowser(`http://localhost:${usePort}${cwdParam}`);
  } else {
    console.warn(`Modus process started, but port ${usePort} is not bound and /health did not respond within 60s.`);
    console.warn("Leaving the child process alone; use `modus status` or Ctrl+C to inspect/stop it.");
  }

  // Wait for process to exit
  await proc.exited;
  if (!stopping) {
    // Process exited on its own (crash or clean exit)
    const code = proc.exitCode ?? 1;
    clearTailscaleServe();
    cleanStateFiles();
    if (code !== 0) {
      console.error(`\nServer exited with code ${code}`);
    }
    process.exit(code);
  }

  cleanStateFiles();
  process.exit(0);
}

async function cmdStop(_args: string[]): Promise<void> {
  const pid = readPidFile();
  const port = readPortFile() ?? BASE_PORT;

  if (!pid || !isPidAlive(pid)) {
    console.log("Modus is not running.");
    cleanStateFiles();
    if (clearTailscaleServe()) console.log("Removed stale tailscale serve rule.");
    return;
  }

  console.log(`Stopping modus (pid ${pid})...`);

  // Try graceful shutdown via HTTP
  const acked = await requestGracefulShutdown(port);
  if (acked) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) break;
      await Bun.sleep(200);
    }
  }

  // Force kill if still alive
  if (isPidAlive(pid)) {
    console.log("Force-killing...");
    killPid(pid);
    await Bun.sleep(500);

    // Last resort: SIGKILL the whole group, not just the leader — a bare SIGKILL
    // here is what leaves the backend and its provider CLIs running as orphans.
    if (isPidAlive(pid)) {
      if (process.platform === "win32") {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      } else {
        signalGroup(pid, "SIGKILL");
      }
    }
  }

  cleanStateFiles();
  if (clearTailscaleServe()) console.log("Removed tailscale serve rule.");
  console.log("Stopped.");
}

async function cmdRemote(args: string[]): Promise<void> {
  const sub = getArg(args, 0);

  if (sub === "on") {
    if (!tailscaleInstalled()) {
      console.error("Tailscale is not installed (or not on PATH).");
      console.error("Install it from https://tailscale.com/download, then re-run: modus remote on");
      process.exit(1);
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(REMOTE_FILE, "tailscale", "utf-8");
    console.log("Remote access enabled — every start now exposes modus on your tailnet.");
    if (!pinConfigured()) {
      console.log("note: no browser PIN is set — anyone on your tailnet can open modus. Consider setting a PIN in settings.");
    }
    // If the server is already running, expose it now.
    const pid = readPidFile();
    if (pid && isPidAlive(pid)) {
      const port = readPortFile() ?? BASE_PORT;
      const ts = setupTailscaleServe(port);
      if (ts.remoteUrl && !ts.error && !ts.skipped) console.log(`remote  ${ts.remoteUrl}`);
      if (ts.skipped) console.log(`tailscale: ${ts.skipped}`);
      if (ts.error) console.log(`tailscale: ${ts.error}`);
    }
    return;
  }

  if (sub === "off") {
    try { unlinkSync(REMOTE_FILE); } catch { /* was not set */ }
    const cleared = clearTailscaleServe(true);
    console.log(`Remote access disabled.${cleared ? " Removed tailscale serve rule." : ""}`);
    return;
  }

  // Default: status
  const persisted = existsSync(REMOTE_FILE);
  console.log(`Remote access: ${persisted ? "on (tailscale)" : "off"}`);
  if (!tailscaleInstalled()) {
    console.log("  tailscale: not installed");
    return;
  }
  const owner = classifyOwnedServeConfig();
  if (owner === "modus") console.log("  tailscale serve: active (modus-owned rule)");
  else if (owner === "foreign") console.log("  tailscale serve: in use by another service — modus will not touch it");
  else console.log("  tailscale serve: no active rule");
}

async function cmdStatus(_args: string[]): Promise<void> {
  const pid = readPidFile();
  const port = readPortFile() ?? BASE_PORT;
  const { version, channel } = loadVersion();

  if (!pid || !isPidAlive(pid)) {
    console.log("Modus is not running.");
    if (pid) cleanStateFiles();
    return;
  }

  console.log(`Modus is running (pid ${pid})`);
  console.log(`  version  ${version} (${channel})`);
  console.log(`  port     ${port}`);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (resp.ok) {
      const data = await resp.json() as { uptime?: number; activeSessions?: number };
      if (data.uptime !== undefined) {
        const mins = Math.floor(data.uptime / 60);
        const secs = Math.floor(data.uptime % 60);
        console.log(`  uptime   ${mins}m ${secs}s`);
      }
      if (data.activeSessions !== undefined) {
        console.log(`  sessions ${data.activeSessions}`);
      }
    }
  } catch {
    console.log("  health   unreachable");
  }
}

async function cmdMaintenance(args: string[]): Promise<void> {
  const subject = getArg(args, 0);
  const apply = hasFlag(args, "--apply");
  const dryRun = hasFlag(args, "--dry-run");
  const planIdIndex = args.indexOf("--plan-id");
  const expectedPlanId = planIdIndex >= 0 ? args[planIdIndex + 1] : undefined;
  if (!(["checkpoints", "storage"].includes(subject ?? "")) || apply === dryRun || (apply && !expectedPlanId)) {
    console.error("Usage:");
    console.error("  modus maintenance checkpoints --dry-run | --apply --plan-id <reviewed-plan-id>");
    console.error("  modus maintenance storage --dry-run | --apply --plan-id <reviewed-plan-id>");
    process.exit(1);
  }
  if (subject === "storage") {
    const { applyStorageMigration, planStorageMigration } = await import("./storage-migration");
    const plan = planStorageMigration();
    if (dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const pid = readPidFile();
    if (pid && isPidAlive(pid)) {
      console.error("Stop Modus before applying a storage migration.");
      process.exit(1);
    }
    console.log(JSON.stringify(applyStorageMigration({
      expectedPlanId: expectedPlanId!,
      locations: plan.locations,
      onProgress: (message) => console.log(`  ${message}`),
    }), null, 2));
    return;
  }
  const { Database } = await import("bun:sqlite");
  const { applyCheckpointMaintenance, planCheckpointMaintenance } = await import("./checkpoint-maintenance");
  const { resolveDatabasePath } = await import("./database-paths");
  const dbPath = resolveDatabasePath("harness.db");
  const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
  try {
    if (dryRun) {
      const rows = db.query(`SELECT * FROM checkpoints ORDER BY cwd, created_at DESC, id DESC`).all() as any[];
      const active = db.query(
        `SELECT id FROM sessions WHERE status IN ('running','starting','interrupting','idle','paused')`,
      ).all() as Array<{ id: string }>;
      console.log(JSON.stringify(planCheckpointMaintenance({
        rows: rows as any,
        protectedSessionIds: new Set(active.map((entry) => entry.id)),
      }), null, 2));
    } else {
      console.log(JSON.stringify(applyCheckpointMaintenance({ db, expectedPlanId: expectedPlanId! }), null, 2));
    }
  } finally {
    db.close();
  }
}

function cmdInit(args: string[]): void {
  // Lazy-import init to avoid loading the full profile system at CLI parse time
  const { initProject } = require("./init") as typeof import("./init");
  const target = resolve(getArg(args, 0) ?? process.cwd());

  console.log(`Initializing .modus/ in: ${target}`);
  const result = initProject(target);

  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.alreadyInitialized) {
    console.log(`Already initialized (project: ${result.projectId})`);
  } else {
    console.log(`Project ID: ${result.projectId}`);
  }

  if (result.created.length > 0) {
    console.log("\nCreated:");
    for (const p of result.created) console.log(`  + ${p}`);
  }
  if (result.skipped.length > 0) {
    console.log("\nSkipped (already exist):");
    for (const p of result.skipped) console.log(`  ~ ${p}`);
  }
}

async function cmdOpen(args: string[]): Promise<void> {
  const target = resolve(getArg(args, 0) ?? process.cwd());

  // Init if needed
  if (!existsSync(join(target, ".modus"))) {
    console.log(`No .modus/ found -- initializing project in ${target}`);
    const { initProject } = require("./init") as typeof import("./init");
    const result = initProject(target);
    if (!result.ok) {
      console.error(`Init failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`Project: ${result.projectId}`);
  }

  // Start if not running
  const pid = readPidFile();
  if (!pid || !isPidAlive(pid)) {
    // Set AGENT_CWD so the harness defaults to this project
    process.env.AGENT_CWD = target;
    return cmdStart(args.filter((a) => a !== target && !a.startsWith("/")));
  }

  // Already running — just open browser with cwd param
  const port = readPortFile() ?? BASE_PORT;
  const url = `http://localhost:${port}?cwd=${encodeURIComponent(target)}`;
  console.log(`Opening project: ${target}`);
  console.log(`  ${url}`);
  openBrowser(url);
}

function cmdSetup(_args: string[]): void {
  console.log("Setting up Modus...\n");

  // 1. Root deps (bun-pty for the Windows terminal PTY — resolves from the
  // repo-root node_modules)
  console.log("Installing root dependencies...");
  const rootResult = Bun.spawnSync([BUN, "install"], {
    cwd: dirname(HARNESS_DIR), stdout: "inherit", stderr: "inherit",
  });
  if (rootResult.exitCode !== 0) {
    console.error("Failed to install root dependencies.");
    process.exit(1);
  }

  // 2. Harness deps
  console.log("\nInstalling harness dependencies...");
  const harnessResult = Bun.spawnSync([BUN, "install"], {
    cwd: HARNESS_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (harnessResult.exitCode !== 0) {
    console.error("Failed to install harness dependencies.");
    process.exit(1);
  }

  // 3. UI deps
  console.log("\nInstalling UI dependencies...");
  if (!existsSync(UI_DIR)) {
    console.error(`UI directory not found: ${UI_DIR}`);
    process.exit(1);
  }
  const uiResult = Bun.spawnSync([BUN, "install"], {
    cwd: UI_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (uiResult.exitCode !== 0) {
    console.error("Failed to install UI dependencies.");
    process.exit(1);
  }

  // 4. Build UI
  console.log("\nBuilding UI...");
  const buildResult = Bun.spawnSync([BUN, "run", "build"], {
    cwd: UI_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (buildResult.exitCode !== 0) {
    console.error("UI build failed.");
    process.exit(1);
  }

  // 5. Register global `modus` command
  console.log("\nRegistering global modus command...");
  const linkResult = Bun.spawnSync([BUN, "link"], {
    cwd: HARNESS_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (linkResult.exitCode !== 0) {
    console.warn("Warning: Could not register global command. You may need to run setup with elevated permissions.");
  } else {
    console.log("Global `modus` command registered.");
  }

  console.log("\nDone. Run `modus start` to launch, or `modus init` in a project folder.");
}

async function cmdDev(args: string[]): Promise<void> {
  // Dev mode: delegate to existing dev.ts or watchdog depending on flags
  if (hasFlag(args, "--watch", "-w")) {
    // Watchdog mode with file watching
    const proc = spawn([BUN, "run", "watchdog.ts"], {
      cwd: HARNESS_DIR,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, MODUS_WATCH_FILES: "1" },
    });
    await proc.exited;
    process.exit(proc.exitCode ?? 0);
  }

  // Default: full dev stack (harness + vite build --watch + vite dev server)
  const proc = spawn([BUN, "run", "dev.ts"], {
    cwd: HARNESS_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

async function cmdLogs(args: string[]): Promise<void> {
  const follow = hasFlag(args, "-f", "--follow");
  const logPath = join(HARNESS_DIR, "watchdog.log");

  if (!existsSync(logPath) && !existsSync(LOG_FILE)) {
    console.log("No log files found.");
    return;
  }

  // Prefer harness.log (daemon mode), fall back to watchdog.log
  const target = existsSync(LOG_FILE) ? LOG_FILE : logPath;

  if (process.platform === "win32") {
    // Windows: no tail command, read file directly
    const content = readFileSync(target, "utf-8");
    const lines = content.split("\n");
    const last100 = lines.slice(-100).join("\n");
    console.log(last100);
    if (follow) {
      console.log("(--follow is not supported on Windows, showing last 100 lines)");
    }
    return;
  }

  const tailArgs = follow ? ["-f", target] : ["-100", target];
  const proc = spawn(["tail", ...tailArgs], {
    stdout: "inherit", stderr: "inherit",
  });
  if (follow) {
    process.on("SIGINT", () => { proc.kill(); process.exit(0); });
  }
  await proc.exited;
}

async function cmdUpdate(_args: string[]): Promise<void> {
  console.log("Updating Modus...\n");

  // Check if running
  const wasRunning = readPidFile() && isPidAlive(readPidFile()!);
  if (wasRunning) {
    console.log("Stopping running instance...");
    await cmdStop([]);
  }

  // Git pull
  console.log("\nPulling latest...");
  const pullResult = Bun.spawnSync(["git", "pull"], {
    cwd: ROOT_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (pullResult.exitCode !== 0) {
    console.error("git pull failed.");
    process.exit(1);
  }

  // Re-setup
  cmdSetup([]);

  // Restart if it was running
  if (wasRunning) {
    console.log("\nRestarting...");
    await cmdStart(["-d"]);
  }
}

function cmdMoves(args: string[]): void {
  const subcommand = args[0];
  if (subcommand !== "export") {
    console.error("Unknown moves subcommand. Supported: export");
    process.exit(1);
  }

  const subArgs = args.slice(1);
  const target = resolve(getPositionalArgs(subArgs, ["--out", "-o"])[0] ?? process.cwd());
  const outPath = getFlagValue(subArgs, "--out", "-o");
  const { exportPortableMoves } = require("./move-export") as typeof import("./move-export");
  const result = exportPortableMoves(target, outPath);

  if (!result.ok) {
    console.error(`Move export failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`Exported ${result.moveNames.length} move(s) to ${result.outputPath}`);
  for (const name of result.moveNames) console.log(`  - ${name}`);
  console.log(`Portable files: ${result.fileCount}`);
  console.log("Import by unzipping into another project's root; the archive includes only direct files from each move.");
}

// ── Main ──

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

// Handle --version / -v anywhere
if (hasFlag(args, "--version", "-v")) {
  const { version, channel } = loadVersion();
  console.log(`modus ${version} (${channel})`);
  process.exit(0);
}

// No command = `modus open .`
if (!command) {
  await cmdOpen([]);
  process.exit(0);
}

// Handle --help / -h
if (hasFlag(args, "--help", "-h")) {
  const { version } = loadVersion();
  console.log(`modus ${version}

Usage: modus <command> [options]

Commands:
  start         Start the server (foreground, ctrl+c to stop)
    -d           Run as background daemon
    --remote     Expose on your tailnet for this run (see: modus remote)
    --no-remote  Skip tailnet exposure for this run
    --show-token Print the harness token in the banner (it is masked by default)
  stop          Stop a running daemon
  status        Show server status
  remote        Show remote access status
    on|off       Persistently expose modus on your tailnet via tailscale serve
  init [path]   Initialize a .modus/ project structure
  open [path]   Init + start + open browser to project
  moves export [path]
                Create a zip of direct move files only, excluding nested folders and runtime/private artifacts
    --out PATH  Write the zip to a specific path
  setup         Install dependencies and build UI
  dev           Dev mode (harness + vite + file watchers)
    --watch      Use watchdog with file watching
  logs          Show server logs
    -f           Follow (live tail)
  update        Pull latest, re-setup, restart if needed
  maintenance   Storage maintenance
    storage --dry-run  Inspect legacy database migration into ~/.modus/data
    storage --apply --plan-id <id>  Apply that exact copy-and-verify plan
    checkpoints --dry-run  Print a non-destructive retention/GC plan
    checkpoints --apply --plan-id <id>  Apply that exact reviewed plan
  --version     Print version`);
  process.exit(0);
}

switch (command) {
  case "__daemon-supervise": await cmdDaemonSupervise(); break;
  case "start":   await cmdStart(commandArgs); break;
  case "stop":    await cmdStop(commandArgs); break;
  case "status":  await cmdStatus(commandArgs); break;
  case "remote":  await cmdRemote(commandArgs); break;
  case "init":    cmdInit(commandArgs); break;
  case "open":    await cmdOpen(commandArgs); break;
  case "moves":   cmdMoves(commandArgs); break;
  case "setup":   cmdSetup(commandArgs); break;
  case "dev":     await cmdDev(commandArgs); break;
  case "logs":    await cmdLogs(commandArgs); break;
  case "update":  await cmdUpdate(commandArgs); break;
  case "maintenance": await cmdMaintenance(commandArgs); break;
  default:
    console.error(`Unknown command: ${command}\nRun 'modus --help' for usage.`);
    process.exit(1);
}
