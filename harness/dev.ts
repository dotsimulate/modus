/**
 * Cross-platform dev launcher — starts harness API + Vite frontend.
 * Replaces dev.sh with zero platform-specific dependencies.
 *
 * Usage: bun run dev
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { networkInterfaces, hostname } from "os";
import { resolve, dirname } from "path";

const BUN = process.execPath;
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const PORT = process.env.HARNESS_PORT || "3777";
const VITE_PORT = "5180";
const TOKEN = process.env.HARNESS_TOKEN ?? randomBytes(16).toString("hex");

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

type TailscaleHttpsSetup = {
  domain: string | null;
  error: string | null;
};

function setupTailscaleHttps(): TailscaleHttpsSetup {
  const status = Bun.spawnSync(["tailscale", "status", "--json"], {
    cwd: SCRIPT_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!status.success) {
    return { domain: null, error: null };
  }

  const payload = JSON.parse(status.stdout.toString()) as TailscaleStatus;
  const dnsName = payload.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) {
    return { domain: null, error: null };
  }

  const tlsDir = resolve(SCRIPT_DIR, ".tailscale");
  mkdirSync(tlsDir, { recursive: true });

  const certPath = resolve(tlsDir, `${dnsName}.crt`);
  const keyPath = resolve(tlsDir, `${dnsName}.key`);
  const cert = Bun.spawnSync([
    "tailscale",
    "cert",
    "--cert-file",
    certPath,
    "--key-file",
    keyPath,
    dnsName,
  ], {
    cwd: SCRIPT_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!cert.success) {
    const details = cert.stderr.toString().trim();
    return {
      domain: null,
      error: details
        ? `${details}\nRemote browser mic capture needs HTTPS on the Tailscale name. Run 'sudo tailscale set --operator=$USER' once, then start the harness again.`
        : "Remote browser mic capture needs HTTPS on the Tailscale name. Run 'sudo tailscale set --operator=$USER' once, then start the harness again.",
    };
  }

  process.env.HARNESS_TLS_CERT = certPath;
  process.env.HARNESS_TLS_KEY = keyPath;
  process.env.HARNESS_TLS_DOMAIN = dnsName;
  return { domain: dnsName, error: null };
}

const { domain: tlsDomain, error: tlsError } = setupTailscaleHttps();
if (tlsError) {
  console.warn(`[dev] Tailscale HTTPS unavailable — falling back to plain HTTP`);
  console.warn(`[dev] (${tlsError.split("\n")[0]})`);
  console.warn(`[dev] Mic capture over network will require HTTPS — local access still works.`);
}

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
  if (tlsDomain) {
    console.log(`  frontend https://${tlsDomain}:${VITE_PORT}`);
  } else {
    console.log(`  frontend http://localhost:${VITE_PORT}`);
  }
  if (!tlsDomain && lanIp) {
    console.log("");
    console.log(`  LAN      http://${lanIp}:${VITE_PORT}`);
    console.log(`           http://${host}.local:${VITE_PORT}`);
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
