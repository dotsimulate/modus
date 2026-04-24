/**
 * Mission Export — dumps a completed (or any) mission run into a readable
 * markdown trace file inside the mission's project directory.
 *
 * Output: <cwd>/.modus/missions/<name>/runs/run-<N>/trace.md
 *
 * Designed to be searchable by agents (grep-friendly headings, structured
 * sections) and readable by humans.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getMissionRun, getMissionRunNumber, getMissionSteps,
  getMissionAssignments, getMissionTransfers, getMissionGateResults,
} from "./mission-db";
import { getSessionMessages } from "./db";
import type {
  MissionRunRow, MissionStepRunRow, MissionAssignmentRow,
  MissionTransferRow, MissionGateResultRow, MissionConfig,
} from "./mission-types";

function ts(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  return new Date(epoch).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function durationStr(start: number, end: number | null | undefined): string {
  if (!end) return "ongoing";
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderSessionExcerpt(sessionId: string | null, maxTurns = 40): string {
  if (!sessionId) return "_no session_\n";
  const msgs = getSessionMessages(sessionId);
  if (msgs.length === 0) return `_session ${sessionId}: no messages_\n`;

  const lines: string[] = [];
  const turns = msgs.slice(0, maxTurns);
  for (const turn of turns) {
    const role = turn.role === "assistant" ? "**assistant**" : "**user**";
    const text = (turn.text ?? "").trim();
    if (!text) continue;
    const truncated = text.length > 2000 ? text.slice(0, 2000) + "\n…[truncated]" : text;
    lines.push(`${role}:\n${truncated}\n`);
  }
  if (msgs.length > maxTurns) {
    lines.push(`_…${msgs.length - maxTurns} more turns omitted_\n`);
  }
  return lines.join("\n");
}

export function exportMissionTrace(runId: number): { ok: boolean; path?: string; error?: string } {
  const run = getMissionRun(runId);
  if (!run) return { ok: false, error: `Run ${runId} not found` };

  const runNumber = getMissionRunNumber(run.mission_name, runId);
  const steps = getMissionSteps(runId);
  const assignments = getMissionAssignments(runId);
  const transfers = getMissionTransfers(runId);
  const gates = getMissionGateResults(runId);

  let config: MissionConfig | null = null;
  try { config = JSON.parse(run.definition_snapshot); } catch {}

  const outDir = join(run.cwd, ".modus", "missions", run.mission_name, "runs", `run-${runNumber}`);
  mkdirSync(outDir, { recursive: true });

  const lines: string[] = [];

  // Header
  lines.push(`# Mission Trace: ${run.mission_name} — Run ${runNumber}`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Run ID | ${run.id} |`);
  lines.push(`| Status | ${run.status} |`);
  lines.push(`| Started | ${ts(run.started_at)} |`);
  lines.push(`| Completed | ${ts(run.completed_at)} |`);
  lines.push(`| Duration | ${durationStr(run.started_at, run.completed_at)} |`);
  lines.push(`| Working Dir | \`${run.cwd}\` |`);
  if (run.current_cycle > 1) lines.push(`| Cycles | ${run.current_cycle} |`);
  if (run.halt_kind) lines.push(`| Halt | ${run.halt_kind}: ${run.halt_message ?? ""} |`);
  lines.push("");

  if (config) {
    lines.push(`## Roles`);
    lines.push("");
    for (const [role, rc] of Object.entries(config.roles)) {
      lines.push(`- **${role}**: profile \`${rc.profile}\`${rc.description ? ` — ${rc.description}` : ""}`);
    }
    lines.push("");
  }

  // Steps
  lines.push(`## Steps`);
  lines.push("");
  for (const step of steps) {
    lines.push(`### ${step.step_order + 1}. ${step.title} (\`${step.step_id}\`) — ${step.status}`);
    lines.push("");
    lines.push(`- Role: ${step.role}`);
    lines.push(`- Started: ${ts(step.started_at)} | Completed: ${ts(step.completed_at)}`);
    if (step.started_at && step.completed_at) {
      lines.push(`- Duration: ${durationStr(step.started_at, step.completed_at)}`);
    }

    // Step gates
    const stepGates = gates.filter(g => g.step_id === step.step_id);
    if (stepGates.length > 0) {
      lines.push("");
      lines.push(`**Gates:**`);
      for (const g of stepGates) {
        const ev = g.evidence ? ` — ${g.evidence}` : "";
        lines.push(`- ${g.gate_type}: **${g.status}**${ev}`);
      }
    }

    // Step assignments
    const stepAssignments = assignments.filter(a => a.step_id === step.step_id);
    if (stepAssignments.length > 0) {
      lines.push("");
      lines.push(`**Assignments:**`);
      for (const a of stepAssignments) {
        lines.push(`- [${a.role}] ${a.status} (session: \`${a.session_id ?? "none"}\`)`);
        if (a.brief) {
          lines.push(`  - Brief: ${a.brief.length > 500 ? a.brief.slice(0, 500) + "…" : a.brief}`);
        }
        if (a.result_summary) {
          lines.push(`  - Result: ${a.result_summary.length > 500 ? a.result_summary.slice(0, 500) + "…" : a.result_summary}`);
        }
      }
    }

    // Step transfers
    const stepTransfers = transfers.filter(t => t.step_id === step.step_id);
    if (stepTransfers.length > 0) {
      lines.push("");
      lines.push(`**Transfers:**`);
      for (const t of stepTransfers) {
        lines.push(`- ${t.kind} at ${ts(t.created_at)}: ${t.summary ?? "(no summary)"}`);
      }
    }

    lines.push("");
  }

  // Session transcripts
  lines.push(`## Session Transcripts`);
  lines.push("");

  // Orchestrator
  if (run.orchestrator_session_id) {
    lines.push(`### Orchestrator (session: \`${run.orchestrator_session_id}\`)`);
    lines.push("");
    lines.push(renderSessionExcerpt(run.orchestrator_session_id));
    lines.push("");
  }

  // Worker sessions
  const workerSessions = new Set<string>();
  for (const a of assignments) {
    if (a.session_id && a.session_id !== run.orchestrator_session_id) {
      workerSessions.add(a.session_id);
    }
  }
  for (const sid of workerSessions) {
    const related = assignments.filter(a => a.session_id === sid);
    const label = related.map(a => `${a.role}/${a.step_id}`).join(", ");
    lines.push(`### Worker: ${label} (session: \`${sid}\`)`);
    lines.push("");
    lines.push(renderSessionExcerpt(sid));
    lines.push("");
  }

  // Transfer log (chronological)
  if (transfers.length > 0) {
    lines.push(`## Transfer Log (Chronological)`);
    lines.push("");
    const sorted = [...transfers].sort((a, b) => a.created_at - b.created_at);
    for (const t of sorted) {
      lines.push(`- **${ts(t.created_at)}** [${t.kind}] step:\`${t.step_id}\` from:\`${t.from_session_id ?? "—"}\` → to:\`${t.to_session_id ?? "—"}\``);
      if (t.summary) lines.push(`  ${t.summary}`);
    }
    lines.push("");
  }

  // Gate log
  if (gates.length > 0) {
    lines.push(`## Gate Results`);
    lines.push("");
    const sorted = [...gates].sort((a, b) => a.checked_at - b.checked_at);
    for (const g of sorted) {
      lines.push(`- ${ts(g.checked_at)} | \`${g.step_id}\` | ${g.gate_type}: **${g.status}**${g.evidence ? ` | ${g.evidence}` : ""}`);
    }
    lines.push("");
  }

  const tracePath = join(outDir, "trace.md");
  writeFileSync(tracePath, lines.join("\n"), "utf-8");

  return { ok: true, path: tracePath };
}
