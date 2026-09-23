import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { APP_PATHS } from "../app-paths";

/**
 * Crash-recoverable installation of Cursor's project MCP configuration.
 *
 * `cursor-agent` reads MCP servers only from `<project>/.cursor/mcp.json` or
 * `~/.cursor/mcp.json`; it exposes no flag for an alternative path, so Modus has
 * to write into the user's project directory to deliver MCP servers at all. That
 * file contains resolved credentials, and the previous implementation held the
 * user's original bytes only in memory and restored them only from `dispose()` —
 * so a backend crash or force-kill stranded a plaintext credential file inside a
 * directory that is frequently git-tracked.
 *
 * This module writes a durable journal *before* touching the project, so any
 * later process can complete the restore. It also refuses to clobber a file the
 * user changed while the session was running.
 */

const JOURNAL_VERSION = 1 as const;

export type CursorMcpJournal = {
  version: typeof JOURNAL_VERSION;
  mcpPath: string;
  /** Original bytes, or null when Modus created the file. */
  backup: string | null;
  /** Permission bits of the original file, restored with its bytes. */
  backupMode?: number;
  /** Hash of exactly what Modus wrote, so concurrent user edits are detectable. */
  installedSha256: string;
  ownerPid: number;
  createdAt: string;
};

export type CursorMcpConfigStore = {
  install(mcpPath: string, content: string): string;
  restore(journalPath: string): "restored" | "removed" | "preserved-user-edit" | "missing";
  recoverStranded(): number;
  journalDir: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function readJournal(path: string): CursorMcpJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed?.version !== JOURNAL_VERSION) return null;
    if (typeof parsed.mcpPath !== "string" || typeof parsed.installedSha256 !== "string") return null;
    if (parsed.backup !== null && typeof parsed.backup !== "string") return null;
    if (parsed.backupMode !== undefined && (!Number.isInteger(parsed.backupMode) || parsed.backupMode < 0 || parsed.backupMode > 0o777)) return null;
    return parsed as CursorMcpJournal;
  } catch {
    return null;
  }
}

export function createCursorMcpConfigStore(journalDir: string): CursorMcpConfigStore {
  function journalPathFor(mcpPath: string): string {
    return join(journalDir, `${sha256(mcpPath).slice(0, 32)}.json`);
  }

  function install(mcpPath: string, content: string): string {
    mkdirSync(journalDir, { recursive: true });
    const backup = existsSync(mcpPath) ? readFileSync(mcpPath, "utf-8") : null;
    const backupMode = backup !== null ? statSync(mcpPath).mode & 0o777 : undefined;
    const journal: CursorMcpJournal = {
      version: JOURNAL_VERSION,
      mcpPath,
      backup,
      backupMode,
      installedSha256: sha256(content),
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    };

    // The journal must be durable before the project file is touched, otherwise a
    // crash in between leaves an unrecoverable overwrite.
    const journalPath = journalPathFor(mcpPath);
    const temp = `${journalPath}.tmp`;
    writeFileSync(temp, JSON.stringify(journal, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(temp, journalPath);

    mkdirSync(dirname(mcpPath), { recursive: true });
    // The mode option only applies when creating a file. Restrict an existing
    // project file before replacing its bytes with resolved credentials.
    if (backup !== null) chmodSync(mcpPath, 0o600);
    // 0600 is a no-op on Windows ACLs.
    writeFileSync(mcpPath, content, { encoding: "utf-8", mode: 0o600 });
    return journalPath;
  }

  function restore(journalPath: string): "restored" | "removed" | "preserved-user-edit" | "missing" {
    const journal = readJournal(journalPath);
    if (!journal) {
      rmSync(journalPath, { force: true });
      return "missing";
    }

    const current = existsSync(journal.mcpPath) ? readFileSync(journal.mcpPath, "utf-8") : null;
    let outcome: "restored" | "removed" | "preserved-user-edit";

    if (current !== null && sha256(current) !== journal.installedSha256) {
      // Someone edited the file after Modus wrote it. Their content wins; we only
      // drop our journal so the credential-bearing bytes are not re-restored.
      outcome = "preserved-user-edit";
    } else if (journal.backup !== null) {
      writeFileSync(journal.mcpPath, journal.backup, "utf-8");
      if (journal.backupMode !== undefined) chmodSync(journal.mcpPath, journal.backupMode);
      outcome = "restored";
    } else {
      rmSync(journal.mcpPath, { force: true });
      outcome = "removed";
    }

    rmSync(journalPath, { force: true });
    return outcome;
  }

  /** Complete restores left behind by a crashed or killed backend. */
  function recoverStranded(): number {
    if (!existsSync(journalDir)) return 0;
    let recovered = 0;
    for (const entry of readdirSync(journalDir)) {
      if (!entry.endsWith(".json")) continue;
      const journalPath = join(journalDir, entry);
      const journal = readJournal(journalPath);
      // Leave entries owned by a live process alone: a second Modus instance may
      // be mid-turn against the same project.
      if (journal && journal.ownerPid !== process.pid && isProcessAlive(journal.ownerPid)) continue;
      const outcome = restore(journalPath);
      if (outcome === "restored" || outcome === "removed") recovered += 1;
    }
    return recovered;
  }

  return { install, restore, recoverStranded, journalDir };
}

export const cursorMcpConfigStore = createCursorMcpConfigStore(
  join(APP_PATHS.runtimeDir, "cursor-mcp"),
);
