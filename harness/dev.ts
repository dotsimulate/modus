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

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PORT = process.env.HARNESS_PORT || "3777";
const TOKEN = process.env.HARNESS_TOKEN ?? randomBytes(16).toString("hex");

// Clear nested-session guard
delete process.env.CLAUDECODE;

// Pass to children
process.env.HARNESS_PORT = PORT;
process.env.HARNESS_TOKEN = TOKEN;

// ── Start processes ──────────────────────────────────────────────

const harness: Subprocess = spawn(["bun", "run", "index.ts"], {
  cwd: SCRIPT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const vite: Subprocess = spawn(["bun", "run", "dev"], {
  cwd: resolve(SCRIPT_DIR, "ui"),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

// ── Cleanup ──────────────────────────────────────────────────────

let stopping = false;
function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log("\nshutting down...");
  harness.kill();
  vite.kill();
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
