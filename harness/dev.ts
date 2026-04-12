/**
 * Cross-platform dev launcher — starts harness API + Vite frontend.
 * Replaces dev.sh with zero platform-specific dependencies.
 *
 * Usage: bun run dev
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
import { networkInterfaces, hostname } from "os";
import { resolve, dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const BUN = process.execPath;
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const PORT = process.env.HARNESS_PORT || "3777";
const VITE_PORT = "5180";

// Persistent token: env > disk > generate new
const TOKEN_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".config", "agent-dev-zone");
const TOKEN_FILE = join(TOKEN_DIR, "harness-token");
let TOKEN = process.env.HARNESS_TOKEN ?? "";
let tokenSource = "env";
if (!TOKEN) {
  try {
    if (existsSync(TOKEN_FILE)) {
      TOKEN = readFileSync(TOKEN_FILE, "utf-8").trim();
      tokenSource = "persisted";
    }
  } catch { /* fall through to generate */ }
  if (!TOKEN) {
    TOKEN = randomBytes(16).toString("hex");
    tokenSource = "new";
    try {
      mkdirSync(TOKEN_DIR, { recursive: true });
      writeFileSync(TOKEN_FILE, TOKEN, "utf-8");
      tokenSource = "persisted";
    } catch (e) {
      console.warn(`[dev] Could not persist token: ${e}`);
    }
  }
}
const APP_PROTOCOL = process.env.HARNESS_TLS_CERT && process.env.HARNESS_TLS_KEY ? "https" : "http";

// Clear nested-session guard
delete process.env.CLAUDECODE;

// Pass to children
process.env.HARNESS_PORT = PORT;
process.env.HARNESS_TOKEN = TOKEN;

type TailscaleStatus = {
  Self?: {
    DNSName?: string;
  };
};

type TailscaleServeSetup = {
  remoteUrl: string | null;
  error: string | null;
};

function setupTailscaleServe(): TailscaleServeSetup {
  const status = Bun.spawnSync(["tailscale", "status", "--json"], {
    cwd: SCRIPT_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!status.success) {
    return { remoteUrl: null, error: null };
  }

  const payload = JSON.parse(status.stdout.toString()) as TailscaleStatus;
  const dnsName = payload.Self?.DNSName?.replace(/\.$/, "") ?? null;
  const remoteUrl = dnsName ? `https://${dnsName}` : null;

  const serve = Bun.spawnSync(["tailscale", "serve", "--bg", PORT], {
    cwd: SCRIPT_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!serve.success) {
    const details = serve.stderr.toString().trim() || serve.stdout.toString().trim() || "tailscale serve failed";
    return { remoteUrl, error: details };
  }

  return { remoteUrl, error: null };
}

const tailscaleServe = setupTailscaleServe();

// ── Start processes ──────────────────────────────────────────────

const viteBuild: Subprocess = spawn([BUN, "x", "vite", "build", "--watch"], {
  cwd: resolve(SCRIPT_DIR, "ui"),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

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

/**
 * Ask the harness to shut itself down gracefully via HTTP.
 * This lets it call server.stop(true), closing all connections and freeing the port.
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

let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log("\nshutting down...");

  // Ask harness to shut down gracefully first — this frees the port cleanly
  const acked = await requestGracefulShutdown();
  if (acked) {
    // Wait up to 5s for the harness to exit on its own
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (harness.exitCode !== null) break;
      await Bun.sleep(200);
    }
  }

  // Force-kill anything still running
  killTree(harness);
  killTree(viteBuild);
  killTree(vite);
}

process.on("SIGINT", () => { cleanup(); });
process.on("SIGTERM", () => { cleanup(); });
process.on("exit", () => { cleanup(); });

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
  console.log(`  app      ${APP_PROTOCOL}://localhost:${PORT}`);
  console.log(`  desktop  http://localhost:${VITE_PORT}`);
  if (tailscaleServe.remoteUrl) {
    console.log("");
    console.log(`  remote   ${tailscaleServe.remoteUrl}`);
  } else if (lanIp) {
    console.log("");
    console.log(`  remote   ${APP_PROTOCOL}://${lanIp}:${PORT}`);
    console.log(`           ${APP_PROTOCOL}://${host}.local:${PORT}`);
  }
  if (tailscaleServe.error) {
    console.log("");
    console.log("  tailscale serve setup failed:");
    console.log(`           ${tailscaleServe.error}`);
  }
  if (TOKEN) {
    console.log("");
    console.log(`  token    ${TOKEN}${tokenSource === "persisted" ? " (persisted)" : ""}`);

  }
  console.log("");
  console.log("  ctrl+c to stop all");
  console.log("");
}, 2000);

// ── Wait for either to exit ──────────────────────────────────────

await Promise.race([harness.exited, viteBuild.exited, vite.exited]);
await cleanup();
process.exit(0);
