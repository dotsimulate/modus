/**
 * Activity Log — system-level audit trail for user + agent activity.
 *
 * Separate DB file (activity.db) from the main harness.db because:
 *   - High-volume, expendable data vs precious session/event data
 *   - Different retention lifecycle (can nuke/rotate without touching sessions)
 *   - Cross-cutting concern, not tied to session lifecycle
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "activity.db");
const adb = new Database(DB_PATH);

adb.run("PRAGMA journal_mode = WAL");

adb.run(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_profile TEXT,
    event_type TEXT NOT NULL,
    session_id TEXT,
    action_name TEXT,
    agent_profile TEXT,
    summary TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
  )
`);
adb.run(`CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_profile, created_at DESC)`);
adb.run(`CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id)`);
adb.run(`CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type, created_at DESC)`);

// ── Types ──

export type ActivityRow = {
  id: number;
  user_profile: string | null;
  event_type: string;
  session_id: string | null;
  action_name: string | null;
  agent_profile: string | null;
  summary: string | null;
  metadata: string | null;
  created_at: number;
};

// ── Prepared Statements ──

const insertStmt = adb.prepare(`
  INSERT INTO activity_log (user_profile, event_type, session_id, action_name, agent_profile, summary, metadata, created_at)
  VALUES ($user_profile, $event_type, $session_id, $action_name, $agent_profile, $summary, $metadata, $created_at)
`);

// ── Write ──

export function logActivity(opts: {
  userProfile?: string;
  eventType: string;
  sessionId?: string;
  actionName?: string;
  agentProfile?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    insertStmt.run({
      $user_profile: opts.userProfile ?? null,
      $event_type: opts.eventType,
      $session_id: opts.sessionId ?? null,
      $action_name: opts.actionName ?? null,
      $agent_profile: opts.agentProfile ?? null,
      $summary: opts.summary ?? null,
      $metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      $created_at: Date.now(),
    });
  } catch (err) {
    console.error("[activity] Failed to log:", err);
  }
}

// ── Read ──

export function getActivityLog(opts?: {
  userProfile?: string;
  since?: number;
  limit?: number;
  eventType?: string;
}): ActivityRow[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts?.userProfile) {
    conditions.push("user_profile = ?");
    params.push(opts.userProfile);
  }
  if (opts?.since) {
    conditions.push("created_at > ?");
    params.push(opts.since);
  }
  if (opts?.eventType) {
    conditions.push("event_type = ?");
    params.push(opts.eventType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  params.push(limit);

  return adb.prepare(
    `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params) as ActivityRow[];
}

export function getActivitySummary(opts?: {
  userProfile?: string;
  hours?: number;
}): { event_type: string; count: number; latest: number }[] {
  const since = Date.now() - ((opts?.hours ?? 24) * 3_600_000);
  const conditions = ["created_at > ?"];
  const params: any[] = [since];

  if (opts?.userProfile) {
    conditions.push("user_profile = ?");
    params.push(opts.userProfile);
  }

  return adb.prepare(`
    SELECT event_type, COUNT(*) as count, MAX(created_at) as latest
    FROM activity_log
    WHERE ${conditions.join(" AND ")}
    GROUP BY event_type
    ORDER BY latest DESC
  `).all(...params) as any[];
}
