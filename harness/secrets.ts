/**
 * Secrets loader — isolates API keys from the project tree.
 *
 * Resolution order for each $VAR_NAME reference:
 *   1. Secrets file (default: ~/.config/harness/secrets.env)
 *   2. Process environment (process.env)
 *   3. Skip with warning
 *
 * The secrets file uses standard KEY=VALUE format (one per line).
 * Lines starting with # are comments. Values can be quoted.
 *
 * Users can override the secrets path via:
 *   - HARNESS_SECRETS_FILE env var
 *   - --secrets-file CLI flag (TODO)
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_DIR = join(homedir(), ".config", "agent-dev-zone");
const DEFAULT_PATH = join(DEFAULT_DIR, "secrets.env");

let secretsStore: Record<string, string> = {};
let loadedFrom: string | null = null;

/** Parse a .env-style file into a key-value record */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

const TEMPLATE = `# Harness secrets — API keys for MCP servers
# This file is read by the harness at startup.
# Keys here are passed ONLY to MCP server subprocesses, never to agents.
# Permissions should be 600 (owner-only read/write).
#
# TAVILY_API_KEY=tvly-...
# BRAVE_API_KEY=BSA...
`;

/** Create the default secrets file if it doesn't exist */
function ensureSecretsFile(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, TEMPLATE, { mode: 0o600 });
    console.log(`[secrets] Created secrets file: ${path}`);
    console.log(`[secrets] Add your API keys there (owner-only permissions).`);
  } catch (err) {
    // Non-fatal — user might not have write access
    console.warn(`[secrets] Could not create ${path}: ${err}`);
  }
}

/** Load secrets from file + environment. Call once at startup. */
export function loadSecrets(): void {
  const path = process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH;

  ensureSecretsFile(path);

  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      secretsStore = parseEnvFile(content);
      loadedFrom = path;
      const count = Object.keys(secretsStore).length;
      if (count > 0) {
        console.log(`[secrets] Loaded ${count} key(s) from ${path}`);
      } else {
        console.log(`[secrets] Secrets file exists but has no keys: ${path}`);
      }
    } catch (err) {
      console.warn(`[secrets] Could not read ${path}: ${err}`);
    }
  } else {
    console.log(`[secrets] No secrets file found (looked at: ${path})`);
  }
}

/**
 * Resolve a $VAR_NAME reference to its actual value.
 * Checks secrets file first, then process.env.
 * Returns undefined if not found anywhere.
 */
export function resolveSecret(varName: string): string | undefined {
  // Secrets file takes priority (isolated, intentional)
  if (varName in secretsStore) return secretsStore[varName];
  // Fallback to process.env (for users who prefer env-only)
  return process.env[varName];
}

/** Check if a secret var is configured (without exposing the value) */
export function isSecretSet(varName: string): boolean {
  return varName in secretsStore || process.env[varName] !== undefined;
}

/**
 * Set the initial PIN — only works if no HARNESS_PIN exists yet.
 * Returns true if set, false if already exists (one-shot setup).
 */
export function setupPin(pin: string): boolean {
  if (isSecretSet("HARNESS_PIN")) return false;

  const path = process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH;
  ensureSecretsFile(path);

  // Update in-memory
  secretsStore["HARNESS_PIN"] = pin;

  // Append to file
  if (existsSync(path)) {
    appendFileSync(path, `\nHARNESS_PIN=${pin}\n`, { mode: 0o600 });
  } else {
    writeFileSync(path, `HARNESS_PIN=${pin}\n`, { mode: 0o600 });
  }
  console.log(`[secrets] PIN set via first-run setup, saved to ${path}`);
  return true;
}

/**
 * Change the PIN — verifies old PIN first, then overwrites the value in the secrets file.
 * Returns true on success, false if old PIN doesn't match or no PIN is set.
 */
export function changePin(oldPin: string, newPin: string): boolean {
  const current = resolveSecret("HARNESS_PIN");
  if (!current || current !== oldPin || !("HARNESS_PIN" in secretsStore)) return false;

  const path = process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH;
  if (!existsSync(path)) return false;

  // Read the file, replace the HARNESS_PIN line, write back
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.match(/^HARNESS_PIN=/)) {
      replaced = true;
      return `HARNESS_PIN=${newPin}`;
    }
    return line;
  });
  if (!replaced) {
    updated.push(`HARNESS_PIN=${newPin}`);
  }
  writeFileSync(path, updated.join("\n"), { mode: 0o600 });
  // Update in-memory store
  secretsStore["HARNESS_PIN"] = newPin;
  return true;
}

/**
 * Replace or create the file-managed PIN for a locally authenticated owner.
 * Environment-managed PINs remain immutable at runtime.
 */
export function resetPin(newPin: string): boolean {
  if (process.env.HARNESS_PIN !== undefined && !("HARNESS_PIN" in secretsStore)) return false;

  const path = process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH;
  ensureSecretsFile(path);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = content.split("\n").filter((line) => !line.match(/^HARNESS_PIN=/));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push(`HARNESS_PIN=${newPin}`, "");
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  secretsStore["HARNESS_PIN"] = newPin;
  return true;
}

/**
 * Remove the configured PIN from the secrets file.
 * Returns false when the PIN is wrong, missing, or supplied only by process.env.
 */
export function disablePin(pin: string): boolean {
  const current = resolveSecret("HARNESS_PIN");
  if (!current || current !== pin || !("HARNESS_PIN" in secretsStore)) return false;

  const path = process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH;
  if (!existsSync(path)) return false;

  const content = readFileSync(path, "utf-8");
  const updated = content
    .split("\n")
    .filter((line) => !line.match(/^HARNESS_PIN=/))
    .join("\n");
  writeFileSync(path, updated.endsWith("\n") ? updated : `${updated}\n`, { mode: 0o600 });
  delete secretsStore["HARNESS_PIN"];
  return true;
}

/** Get info about where secrets are loaded from (for startup log) */
export function getSecretsInfo(): { path: string; loadedFrom: string | null; count: number } {
  return {
    path: process.env.HARNESS_SECRETS_FILE ?? DEFAULT_PATH,
    loadedFrom,
    count: Object.keys(secretsStore).length,
  };
}
