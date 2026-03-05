/**
 * Cross-platform dev launcher — starts harness API + Vite frontend.
 * Replaces dev.sh with zero platform-specific dependencies.
 *
 * Usage: bun run dev
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
import { networkInterfaces, hostname } from "os";
import { resolve, dirname } from "path";

const BUN = process.execPath;
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const PORT = process.env.HARNESS_PORT || "3777";
const TOKEN = process.env.HARNESS_TOKEN ?? randomBytes(16).toString("hex");

// Clear nested-session guard
delete process.env.CLAUDECODE;

// Pass to children
process.env.HARNESS_PORT = PORT;
process.env.HARNESS_TOKEN = TOKEN;

// ── Start processes ──────────────────────────────────────────────

const harness: Subprocess = spawn([BUN, "run", "index.ts"], {
  cwd: SCRIPT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const vite: Subprocess = spawn([BUN, "run", "dev"], {
  cwd: resolve(SCRIPT_DIR, "ui"),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

// ── Cleanup ──────────────────────────────────────────────────────

/** Kill a subprocess tree. On Windows, kill() only kills the direct child,
 *  leaving grandchildren (e.g. the actual vite node process) orphaned.
 *  Use taskkill /T /F to kill the entire process tree. */
function killTree(proc: Subprocess) {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" });
    } else {
      proc.kill();
    }
  } catch { /* best effort */ }
}

let stopping = false;
function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log("\nshutting down...");
  killTree(harness);
  killTree(vite);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

// ── Print info after a brief settle ──────────────────────────────

function getLanIp(): string | undefined {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
}

setTimeout(() => {
  const lanIp = getLanIp();
  const host = hostname();

  console.log("");
  console.log(`  harness  http://localhost:${PORT}`);
  console.log(`  frontend http://localhost:5180`);
  if (lanIp) {
    console.log("");
    console.log(`  LAN      http://${lanIp}:5180`);
    console.log(`           http://${host}.local:5180`);
  }
  if (TOKEN) {
    console.log("");
    console.log(`  token    ${TOKEN}`);
  }
  console.log("");
  console.log("  ctrl+c to stop both");
  console.log("");
}, 2000);

// ── Wait for either to exit ──────────────────────────────────────

await Promise.race([harness.exited, vite.exited]);
cleanup();
process.exit(0);
