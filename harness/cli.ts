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
 *   init [path] Initialize a .modus/ project
 *   open [path] Init + start + open browser to project
 *   setup       Install dependencies and build UI
 *   dev         Dev mode (harness + vite + file watchers)
 *   logs        Tail server output
 *   update      Pull latest + re-setup + restart
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

// ── Tailscale Serve ──

type TailscaleServeSetup = {
  remoteUrl: string | null;
  error: string | null;
};

function setupTailscaleServe(port: number): TailscaleServeSetup {
  const status = spawnSync("tailscale", ["status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (status.status !== 0) {
    return { remoteUrl: null, error: null }; // Tailscale not installed or not running
  }

  try {
    const payload = JSON.parse(status.stdout.toString());
    const dnsName = payload?.Self?.DNSName?.replace(/\.$/, "") ?? null;
    const remoteUrl = dnsName ? `https://${dnsName}` : null;

    const serve = spawnSync("tailscale", ["serve", "--bg", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    if (serve.status !== 0) {
      const details = serve.stderr?.toString().trim() || serve.stdout?.toString().trim() || "tailscale serve failed";
      return { remoteUrl, error: details };
    }

    return { remoteUrl, error: null };
  } catch {
    return { remoteUrl: null, error: "failed to parse tailscale status" };
  }
}

// ── Paths ──

const HARNESS_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(HARNESS_DIR, "..");
const UI_DIR = join(HARNESS_DIR, "ui");
const UI_SRC_DIR = join(UI_DIR, "src");
const UI_DIST_DIR = join(UI_DIR, "dist");
const BUN = process.execPath;

const CONFIG_DIR = join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".config", "agent-dev-zone",
);
const TOKEN_FILE = join(CONFIG_DIR, "harness-token");
const PID_FILE = join(CONFIG_DIR, "harness.pid");
const PORT_FILE = join(CONFIG_DIR, "harness.port");
const LOG_FILE = join(HARNESS_DIR, "harness.log");

const BASE_PORT = Number(process.env.HARNESS_PORT ?? 3777);

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

function killTree(proc: Subprocess): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
        stdout: "ignore", stderr: "ignore",
      });
    } else {
      proc.kill();
    }
  } catch { /* best effort */ }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], {
        stdout: "ignore", stderr: "ignore",
      });
    } else {
      process.kill(pid, "SIGTERM");
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
    const nmTime = statSync(nmDir).mtimeMs;
    const pkgTime = existsSync(pkgJson) ? statSync(pkgJson).mtimeMs : 0;
    const lockTime = existsSync(lockFile) ? statSync(lockFile).mtimeMs : 0;
    return Math.max(pkgTime, lockTime) > nmTime;
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

// ── Commands ──

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
    const PORT_SCAN_RANGE = 5;
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

  // Token
  const { token, source: tokenSource } = loadToken();

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
    const proc = spawn([BUN, "run", "index.ts"], {
      cwd: HARNESS_DIR,
      stdout: logFd,
      stderr: logFd,
      env,
    });

    // Detach: unref so CLI can exit while child runs
    proc.unref();
    writeStateFiles(proc.pid, usePort);

    console.log("Starting modus daemon...");
    const healthy = await waitForHealth(usePort);
    if (!healthy) {
      console.error("Server did not become healthy within 15s. Check logs: modus logs");
      process.exit(1);
    }

    const lanIp = getLanIp();
    const ts = setupTailscaleServe(usePort);
    console.log(`Modus running (pid ${proc.pid})`);
    console.log(`  http://localhost:${usePort}`);
    if (lanIp) console.log(`  http://${lanIp}:${usePort}`);
    if (ts.remoteUrl) console.log(`  remote  ${ts.remoteUrl}`);
    if (ts.error) console.log(`  tailscale: ${ts.error}`);
    console.log(`  token: ${token} (${tokenSource})`);
    console.log(`  logs:  modus logs`);

    const cwdParam = process.env.AGENT_CWD
      ? `?cwd=${encodeURIComponent(process.env.AGENT_CWD)}`
      : "";
    openBrowser(`http://localhost:${usePort}${cwdParam}`);
    return;
  }

  // ── Foreground mode ──
  const proc = spawn([BUN, "run", "index.ts"], {
    cwd: HARNESS_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  writeStateFiles(proc.pid, usePort);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down...");

    const acked = await requestGracefulShutdown(usePort);
    if (acked) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) break;
        await Bun.sleep(200);
      }
    }

    if (proc.exitCode === null) {
      killTree(proc);
    }

    cleanStateFiles();
  }

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  // Wait for health, then print info and open browser
  const healthy = await waitForHealth(usePort);
  if (healthy) {
    const lanIp = getLanIp();
    const host = hostname();
    const ts = setupTailscaleServe(usePort);
    console.log("");
    console.log(`  modus   http://localhost:${usePort}`);
    if (lanIp) {
      console.log(`  lan     http://${lanIp}:${usePort}`);
      console.log(`          http://${host}.local:${usePort}`);
    }
    if (ts.remoteUrl) console.log(`  remote  ${ts.remoteUrl}`);
    if (ts.error) {
      console.log("");
      console.log("  tailscale serve setup failed:");
      console.log(`           ${ts.error}`);
    }
    console.log(`  token   ${token} (${tokenSource})`);
    console.log("");
    console.log("  ctrl+c to stop");
    console.log("");
    const cwdParam = process.env.AGENT_CWD
      ? `?cwd=${encodeURIComponent(process.env.AGENT_CWD)}`
      : "";
    openBrowser(`http://localhost:${usePort}${cwdParam}`);
  }

  // Wait for process to exit
  await proc.exited;
  if (!stopping) {
    // Process exited on its own (crash or clean exit)
    const code = proc.exitCode ?? 1;
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

    // Last resort: SIGKILL
    if (isPidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }

  cleanStateFiles();
  console.log("Stopped.");
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

  // 1. Harness deps
  console.log("Installing harness dependencies...");
  const harnessResult = Bun.spawnSync([BUN, "install"], {
    cwd: HARNESS_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (harnessResult.exitCode !== 0) {
    console.error("Failed to install harness dependencies.");
    process.exit(1);
  }

  // 2. UI deps
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

  // 3. Build UI
  console.log("\nBuilding UI...");
  const buildResult = Bun.spawnSync([BUN, "run", "build"], {
    cwd: UI_DIR, stdout: "inherit", stderr: "inherit",
  });
  if (buildResult.exitCode !== 0) {
    console.error("UI build failed.");
    process.exit(1);
  }

  // 4. Register global `modus` command
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
  stop          Stop a running daemon
  status        Show server status
  init [path]   Initialize a .modus/ project structure
  open [path]   Init + start + open browser to project
  setup         Install dependencies and build UI
  dev           Dev mode (harness + vite + file watchers)
    --watch      Use watchdog with file watching
  logs          Show server logs
    -f           Follow (live tail)
  update        Pull latest, re-setup, restart if needed
  --version     Print version`);
  process.exit(0);
}

switch (command) {
  case "start":   await cmdStart(commandArgs); break;
  case "stop":    await cmdStop(commandArgs); break;
  case "status":  await cmdStatus(commandArgs); break;
  case "init":    cmdInit(commandArgs); break;
  case "open":    await cmdOpen(commandArgs); break;
  case "setup":   cmdSetup(commandArgs); break;
  case "dev":     await cmdDev(commandArgs); break;
  case "logs":    await cmdLogs(commandArgs); break;
  case "update":  await cmdUpdate(commandArgs); break;
  default:
    console.error(`Unknown command: ${command}\nRun 'modus --help' for usage.`);
    process.exit(1);
}
