/**
 * Mission Runner — loads, starts, and orchestrates mission workflows.
 *
 * Missions are the project-level orchestration primitive. They coordinate
 * multiple agents across steps with gates (handoff, tests, commit, review).
 *
 * The runner:
 *   - Loads mission definitions from .modus/missions/<name>/mission.json
 *   - Snapshots the definition into a DB run record at start
 *   - Creates per-step runtime rows
 *   - Spawns the orchestrator session with mission tools
 *   - Mints scoped mission tokens (command bus via modus_submit)
 *   - Validates gates, manages step transitions, pause/resume
 *
 * The model interacts via modus_submit with { token, data: { op, ...payload } }.
 * Token type discrimination happens in modus-mcp.ts.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { startSession, getActiveSession, type StartSessionOpts } from "./session-manager";
import { logActivity } from "./activity";
import {
  insertMissionRun, getMissionRun, listMissionRuns, updateMissionRun,
  insertMissionStep, getMissionSteps, getMissionStep, updateMissionStep,
  insertMissionAssignment, getMissionAssignments, getMissionAssignment, updateMissionAssignment,
  insertMissionTransfer, getMissionTransfers,
  insertMissionGateResult, getMissionGateResults, getStepGateResults,
  getMissionRunSessionIds,
} from "./mission-db";
import type {
  MissionConfig, MissionCommand, MissionToolGrant, MissionOp,
  MissionRunRow, MissionStepRunRow, MissionGateType,
  MissionListItem, MissionRunSummary, MissionStepRunSummary,
  MissionAssignmentSummary, MissionTransferSummary, MissionGateResultSummary,
} from "./mission-types";

// ── Constants ──

const MODUS_MISSIONS_DIR = ".modus/missions";
const GRANT_TTL_MS = 60 * 60_000; // 1 hour
const GRANT_CLEANUP_INTERVAL_MS = 60_000;

// ── Grant Store (in-memory, keyed by token) ──

const grantStore = new Map<string, MissionToolGrant>();

setInterval(() => {
  const now = Date.now();
  for (const [key, grant] of grantStore) {
    if (now - grant.createdAt > GRANT_TTL_MS) {
      grantStore.delete(key);
    }
  }
}, GRANT_CLEANUP_INTERVAL_MS);

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "mis-" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

/** Check if a token is a mission grant token */
export function isMissionToken(token: string): boolean {
  return token.startsWith("mis-");
}

export function getGrant(token: string): MissionToolGrant | undefined {
  return grantStore.get(token);
}

// ── Mission Loading ──

function missionsDir(cwd: string): string {
  return join(cwd, MODUS_MISSIONS_DIR);
}

export function getMission(name: string, cwd: string): MissionConfig | null {
  const configPath = join(missionsDir(cwd), name, "mission.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config: MissionConfig = JSON.parse(raw);
    config.name = name;
    return config;
  } catch (err) {
    console.error(`[mission-runner] Failed to load mission "${name}":`, err);
    return null;
  }
}

export function listMissions(cwd: string): MissionListItem[] {
  const dir = missionsDir(cwd);
  if (!existsSync(dir)) return [];
  const items: MissionListItem[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const config = getMission(entry.name, cwd);
      if (!config) continue;
      items.push({
        name: config.name,
        label: config.label,
        description: config.description,
        enabled: config.enabled !== false,
        stepCount: config.steps.length,
        roles: Object.keys(config.roles),
        tags: config.tags ?? [],
      });
    }
  } catch { /* directory not readable */ }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Start Mission ──

export async function startMission(opts: {
  missionName: string;
  cwd: string;
  userProfile?: string;
}): Promise<{ runId: number } | { error: string }> {
  const config = getMission(opts.missionName, opts.cwd);
  if (!config) return { error: `Mission not found: ${opts.missionName}` };
  if (config.enabled === false) return { error: `Mission is disabled: ${opts.missionName}` };

  // Validate roles reference real profiles (just warn, don't block)
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    if (!roleConfig.profile) {
      console.warn(`[mission-runner] Role "${role}" has no profile mapping`);
    }
  }

  // Validate steps reference defined roles
  for (const step of config.steps) {
    if (!config.roles[step.role]) {
      return { error: `Step "${step.id}" references undefined role "${step.role}"` };
    }
    if (step.reviewer && !config.roles[step.reviewer]) {
      return { error: `Step "${step.id}" reviewer references undefined role "${step.reviewer}"` };
    }
  }

  // Snapshot definition and create run
  const runId = insertMissionRun({
    missionName: opts.missionName,
    cwd: opts.cwd,
    userProfile: opts.userProfile,
    definitionSnapshot: JSON.stringify(config),
  });

  // Create step rows
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    insertMissionStep({
      runId,
      stepId: step.id,
      stepOrder: i,
      role: step.role,
      title: step.label,
    });
  }

  // Mint orchestrator grant
  const orchestratorRole = "orchestrator";
  const orchestratorProfile = config.roles[orchestratorRole]?.profile ?? config.roles[Object.keys(config.roles)[0]]?.profile;
  if (!orchestratorProfile) {
    return { error: "No orchestrator role or fallback profile defined" };
  }

  const orchestratorToken = generateToken();
  const orchestratorGrant: MissionToolGrant = {
    token: orchestratorToken,
    runId,
    role: orchestratorRole,
    sessionId: "", // set after session start
    allowedOps: ["read", "delegate", "report", "gate", "pause"],
    createdAt: Date.now(),
  };
  grantStore.set(orchestratorToken, orchestratorGrant);

  // Build orchestrator prompt
  const prompt = buildOrchestratorPrompt(config, runId, orchestratorToken);

  // Spawn orchestrator session
  const sessionOpts: StartSessionOpts = {
    prompt,
    profile: orchestratorProfile,
    cwd: opts.cwd,
    userProfile: opts.userProfile,
  };

  const session = startSession(sessionOpts);

  // Wait for real session ID
  const start = Date.now();
  while (session.sessionId.startsWith("ses-") && Date.now() - start < 8000) {
    await Bun.sleep(100);
  }

  // Update grant and run with session ID
  orchestratorGrant.sessionId = session.sessionId;
  updateMissionRun(runId, {
    status: "running",
    orchestratorSessionId: session.sessionId,
  });

  // Tag the session
  // (Tags are set via session metadata — the session-manager will pick these up)

  logActivity({
    userProfile: opts.userProfile,
    eventType: "mission_start",
    summary: `Mission started: ${config.label}`,
    metadata: { missionName: opts.missionName, runId },
  });

  return { runId };
}

// ── Prompt Construction ──

function buildOrchestratorPrompt(config: MissionConfig, runId: number, token: string): string {
  const steps = config.steps.map((s, i) => {
    const gates = s.gates.map(g => g.type).join(", ");
    return `  ${i + 1}. [${s.id}] ${s.label} (role: ${s.role}${s.reviewer ? `, reviewer: ${s.reviewer}` : ""}) — gates: ${gates || "none"}`;
  }).join("\n");

  const roles = Object.entries(config.roles).map(([name, r]) => {
    return `  - ${name}: profile "${r.profile}"${r.description ? ` — ${r.description}` : ""}`;
  }).join("\n");

  return `# Mission: ${config.label}

## Objective
${config.description}

## Your Role
You are the **orchestrator** for this mission. Your job is delegation, gate-checking, and state management. You do NOT write code, run tests, or implement features yourself. You delegate to worker agents and track their progress.

## Steps (frozen — you cannot add, remove, or reorder)
${steps}

## Roles
${roles}

## Rules
- One active step at a time. Complete current step before advancing.
- Each step must pass all its required gates before it can complete.
- You can refine step briefs and delegation instructions, but NOT the step structure.
- When delegating, use the \`modus_submit\` tool with your mission token.
${config.policy.requireTestsBeforeAdvance ? "- Tests are REQUIRED before advancing any step with a tests gate." : ""}
${config.policy.requireCommitBeforeAdvance ? "- A commit is REQUIRED before advancing any step with a commit gate." : ""}
${config.policy.requireHandoffOnTransfer ? "- A handoff summary is REQUIRED on every delegation transfer." : ""}

## Mission Command Bus
Use the \`modus_submit\` MCP tool for all mission operations.
Your token: \`${token}\`

### Available Operations

**Read mission state:**
\`\`\`json
{ "token": "${token}", "data": { "op": "read" } }
\`\`\`

**Delegate a step to a worker:**
\`\`\`json
{ "token": "${token}", "data": { "op": "delegate", "stepId": "...", "role": "...", "brief": "...", "transferSummary": "..." } }
\`\`\`

**Report step completion/failure (workers use this):**
\`\`\`json
{ "token": "${token}", "data": { "op": "report", "stepId": "...", "status": "completed|failed", "summary": "...", "filesChanged": [], "commits": [], "testResults": "..." } }
\`\`\`

**Record a gate result:**
\`\`\`json
{ "token": "${token}", "data": { "op": "gate", "stepId": "...", "gate": "handoff|tests|commit|review", "status": "pass|fail", "evidence": "..." } }
\`\`\`

**Pause the mission:**
\`\`\`json
{ "token": "${token}", "data": { "op": "pause", "reason": "..." } }
\`\`\`

## Getting Started
1. Read the mission state to see current status.
2. Begin with the first step: delegate it to the appropriate role.
3. Monitor gate completion. Advance when all gates pass.
4. Continue through all steps until the mission is complete.

Mission Run ID: ${runId}
`;
}

function buildWorkerPrompt(
  config: MissionConfig,
  step: { id: string; label: string; description?: string },
  brief: string,
  token: string,
  runId: number,
): string {
  return `# Mission Worker Assignment

## Mission: ${config.label}
## Step: ${step.label} [${step.id}]
${step.description ? `\n${step.description}\n` : ""}
## Your Brief
${brief}

## When Done
Use the \`modus_submit\` MCP tool to report your results:

\`\`\`json
{ "token": "${token}", "data": { "op": "report", "stepId": "${step.id}", "status": "completed", "summary": "what you did", "filesChanged": ["..."], "commits": ["..."], "testResults": "..." } }
\`\`\`

If you encounter a blocking problem you cannot resolve:
\`\`\`json
{ "token": "${token}", "data": { "op": "report", "stepId": "${step.id}", "status": "failed", "summary": "what went wrong" } }
\`\`\`

Mission Run ID: ${runId}
`;
}

// ── Command Bus Handler ──

export async function handleMissionCommand(
  token: string,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; error?: string; result?: unknown }> {
  const grant = grantStore.get(token);
  if (!grant) {
    return { ok: false, error: "Invalid or expired mission token" };
  }

  const op = data.op as string;
  if (!op || !grant.allowedOps.includes(op as MissionOp)) {
    return { ok: false, error: `Operation "${op}" not allowed for this token. Allowed: ${grant.allowedOps.join(", ")}` };
  }

  const run = getMissionRun(grant.runId);
  if (!run) {
    return { ok: false, error: "Mission run not found" };
  }

  if (run.status !== "running" && op !== "read") {
    return { ok: false, error: `Mission is ${run.status}, only "read" is allowed` };
  }

  const cmd = data as unknown as MissionCommand;

  switch (cmd.op) {
    case "read":
      return handleRead(run);
    case "delegate":
      return handleDelegate(run, grant, cmd);
    case "report":
      return handleReport(run, grant, cmd);
    case "gate":
      return handleGate(run, grant, cmd);
    case "pause":
      return handlePause(run, grant, cmd);
    default:
      return { ok: false, error: `Unknown operation: ${op}` };
  }
}

// ── Op Handlers ──

function handleRead(run: MissionRunRow): { ok: boolean; result: unknown } {
  const steps = getMissionSteps(run.id);
  const assignments = getMissionAssignments(run.id);
  const gates = getMissionGateResults(run.id);

  return {
    ok: true,
    result: {
      runId: run.id,
      missionName: run.mission_name,
      status: run.status,
      currentStepIndex: run.current_step_index,
      haltKind: run.halt_kind,
      haltMessage: run.halt_message,
      steps: steps.map(s => ({
        stepId: s.step_id,
        title: s.title,
        role: s.role,
        status: s.status,
        order: s.step_order,
      })),
      recentAssignments: assignments.slice(0, 10).map(a => ({
        stepId: a.step_id,
        role: a.role,
        status: a.status,
        brief: a.brief,
        resultSummary: a.result_summary,
      })),
      gateResults: gates.map(g => ({
        stepId: g.step_id,
        gate: g.gate_type,
        status: g.status,
        evidence: g.evidence,
      })),
    },
  };
}

async function handleDelegate(
  run: MissionRunRow,
  grant: MissionToolGrant,
  cmd: Extract<MissionCommand, { op: "delegate" }>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { stepId, role, brief, transferSummary } = cmd;

  // Validate step exists and is current
  const step = getMissionStep(run.id, stepId);
  if (!step) return { ok: false, error: `Step "${stepId}" not found` };
  if (step.status === "completed") return { ok: false, error: `Step "${stepId}" is already completed` };

  // Parse definition for role/profile lookup
  const config: MissionConfig = JSON.parse(run.definition_snapshot);
  const roleConfig = config.roles[role];
  if (!roleConfig) return { ok: false, error: `Role "${role}" not defined in mission` };

  // Create assignment
  const assignmentId = insertMissionAssignment({
    runId: run.id,
    stepId,
    role,
    sourceSessionId: grant.sessionId,
    brief,
  });

  // Mark step as running
  if (step.status === "pending") {
    updateMissionStep(step.id, {
      status: "running",
      activeAssignmentId: assignmentId,
      startedAt: Date.now(),
    });
    // Update run's current step index
    updateMissionRun(run.id, { currentStepIndex: step.step_order });
  }

  // Mint worker token
  const workerToken = generateToken();
  const workerOps: MissionOp[] = ["read", "report"];
  // Reviewers also get gate
  const stepDef = config.steps.find(s => s.id === stepId);
  if (stepDef?.reviewer === role) {
    workerOps.push("gate");
  }

  const workerGrant: MissionToolGrant = {
    token: workerToken,
    runId: run.id,
    role,
    sessionId: "", // set after spawn
    allowedOps: workerOps,
    createdAt: Date.now(),
  };
  grantStore.set(workerToken, workerGrant);

  // Build worker prompt
  const workerPrompt = buildWorkerPrompt(
    config,
    { id: stepId, label: step.title, description: stepDef?.description },
    brief,
    workerToken,
    run.id,
  );

  // Spawn worker session
  const session = startSession({
    prompt: workerPrompt,
    profile: roleConfig.profile,
    cwd: run.cwd,
    userProfile: run.user_profile ?? undefined,
  });

  // Wait for real session ID
  const start = Date.now();
  while (session.sessionId.startsWith("ses-") && Date.now() - start < 8000) {
    await Bun.sleep(100);
  }

  workerGrant.sessionId = session.sessionId;
  updateMissionAssignment(assignmentId, { sessionId: session.sessionId });

  // Record transfer
  if (transferSummary) {
    insertMissionTransfer({
      runId: run.id,
      stepId,
      fromSessionId: grant.sessionId,
      toSessionId: session.sessionId,
      kind: "delegation",
      summary: transferSummary,
    });
  }

  logActivity({
    userProfile: run.user_profile ?? undefined,
    eventType: "mission_delegate",
    sessionId: grant.sessionId,
    summary: `Delegated step "${stepId}" to ${role} (${roleConfig.profile})`,
    metadata: { runId: run.id, stepId, role, assignmentId },
  });

  return { ok: true, message: `Delegated "${stepId}" to ${role}. Worker session: ${session.sessionId}` };
}

async function handleReport(
  run: MissionRunRow,
  grant: MissionToolGrant,
  cmd: Extract<MissionCommand, { op: "report" }>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { stepId, status, summary } = cmd;

  const step = getMissionStep(run.id, stepId);
  if (!step) return { ok: false, error: `Step "${stepId}" not found` };

  // Find the active assignment for this session
  const assignments = getMissionAssignments(run.id);
  const assignment = assignments.find(
    a => a.step_id === stepId && a.session_id === grant.sessionId && a.status === "active"
  );

  if (assignment) {
    updateMissionAssignment(assignment.id, {
      status: status === "completed" ? "completed" : "failed",
      resultSummary: summary,
      failureKind: status === "failed" ? "AGENT_FAILURE" : null,
      completedAt: Date.now(),
    });
  }

  // Record transfer (report back)
  insertMissionTransfer({
    runId: run.id,
    stepId,
    fromSessionId: grant.sessionId,
    toSessionId: run.orchestrator_session_id,
    kind: "report",
    summary,
    details: JSON.stringify({
      filesChanged: cmd.filesChanged,
      commits: cmd.commits,
      testResults: cmd.testResults,
      handoffSummary: cmd.handoffSummary,
    }),
  });

  const eventType = status === "completed" ? "mission_report" : "mission_error";
  logActivity({
    userProfile: run.user_profile ?? undefined,
    eventType,
    sessionId: grant.sessionId,
    summary: `Step "${stepId}" ${status}: ${summary}`,
    metadata: { runId: run.id, stepId, status },
  });

  // If completed, check if all gates pass
  if (status === "completed") {
    const allGatesPassed = checkStepGates(run, stepId);
    if (allGatesPassed) {
      return { ok: true, message: `Step "${stepId}" reported complete. All gates passed — step can advance.` };
    }
    return { ok: true, message: `Step "${stepId}" reported complete. Some gates still pending — check gate status.` };
  }

  return { ok: true, message: `Step "${stepId}" reported as failed. Orchestrator should decide next action.` };
}

function handleGate(
  run: MissionRunRow,
  grant: MissionToolGrant,
  cmd: Extract<MissionCommand, { op: "gate" }>,
): { ok: boolean; message?: string; error?: string } {
  const { stepId, gate, status, evidence } = cmd;

  const step = getMissionStep(run.id, stepId);
  if (!step) return { ok: false, error: `Step "${stepId}" not found` };

  // Validate gate type is defined for this step
  const config: MissionConfig = JSON.parse(run.definition_snapshot);
  const stepDef = config.steps.find(s => s.id === stepId);
  if (!stepDef) return { ok: false, error: `Step "${stepId}" not in definition` };

  const gateDef = stepDef.gates.find(g => g.type === gate);
  if (!gateDef) return { ok: false, error: `Gate "${gate}" not defined for step "${stepId}"` };

  insertMissionGateResult({
    runId: run.id,
    stepId,
    gateType: gate,
    status,
    evidence,
  });

  const eventType = status === "pass" ? "mission_gate_pass" : "mission_gate_fail";
  logActivity({
    userProfile: run.user_profile ?? undefined,
    eventType,
    sessionId: grant.sessionId,
    summary: `Gate ${gate} ${status} for step "${stepId}"`,
    metadata: { runId: run.id, stepId, gate, status },
  });

  // Check if all gates now pass
  if (status === "pass") {
    const allPassed = checkStepGates(run, stepId);
    if (allPassed) {
      // Auto-advance step
      updateMissionStep(step.id, {
        status: "completed",
        completedAt: Date.now(),
      });

      // Check if mission is complete
      const allSteps = getMissionSteps(run.id);
      const allComplete = allSteps.every(s => s.status === "completed" || s.status === "skipped");
      if (allComplete) {
        updateMissionRun(run.id, {
          status: "completed",
          completedAt: Date.now(),
        });
        logActivity({
          userProfile: run.user_profile ?? undefined,
          eventType: "mission_complete",
          summary: `Mission completed: ${run.mission_name}`,
          metadata: { runId: run.id },
        });
        return { ok: true, message: `Gate ${gate} passed. Step "${stepId}" complete. Mission complete!` };
      }

      return { ok: true, message: `Gate ${gate} passed. Step "${stepId}" complete. Advance to next step.` };
    }
  }

  return { ok: true, message: `Gate ${gate} recorded as ${status} for step "${stepId}".` };
}

function handlePause(
  run: MissionRunRow,
  grant: MissionToolGrant,
  cmd: Extract<MissionCommand, { op: "pause" }>,
): { ok: boolean; message?: string } {
  updateMissionRun(run.id, {
    status: "paused",
    haltKind: "MISSION_PAUSED",
    haltMessage: cmd.reason,
  });

  logActivity({
    userProfile: run.user_profile ?? undefined,
    eventType: "mission_pause",
    sessionId: grant.sessionId,
    summary: `Mission paused: ${cmd.reason}`,
    metadata: { runId: run.id, reason: cmd.reason },
  });

  return { ok: true, message: `Mission paused: ${cmd.reason}` };
}

// ── Gate Checking ──

function checkStepGates(run: MissionRunRow, stepId: string): boolean {
  const config: MissionConfig = JSON.parse(run.definition_snapshot);
  const stepDef = config.steps.find(s => s.id === stepId);
  if (!stepDef) return false;

  const requiredGates = stepDef.gates.filter(g => g.required !== false);
  if (requiredGates.length === 0) return true;

  const gateResults = getStepGateResults(run.id, stepId);

  for (const gate of requiredGates) {
    // Find the latest result for this gate type
    const latest = gateResults.find(r => r.gate_type === gate.type);
    if (!latest || latest.status !== "pass") return false;
  }

  return true;
}

// ── Pause / Resume (external API) ──

export function pauseMissionRun(runId: number, reason: string): { ok: boolean; error?: string } {
  const run = getMissionRun(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status !== "running") return { ok: false, error: `Run is ${run.status}, cannot pause` };

  updateMissionRun(runId, {
    status: "paused",
    haltKind: "MISSION_PAUSED",
    haltMessage: reason,
  });

  logActivity({
    eventType: "mission_pause",
    summary: `Mission paused externally: ${reason}`,
    metadata: { runId, reason },
  });

  return { ok: true };
}

export function resumeMissionRun(runId: number): { ok: boolean; error?: string } {
  const run = getMissionRun(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status !== "paused") return { ok: false, error: `Run is ${run.status}, cannot resume` };

  updateMissionRun(runId, {
    status: "running",
    haltKind: null,
    haltMessage: null,
  });

  logActivity({
    eventType: "mission_resume",
    summary: `Mission resumed: ${run.mission_name}`,
    metadata: { runId },
  });

  return { ok: true };
}

// ── Query Functions (for REST API) ──

export function getMissionRunSummary(runId: number): MissionRunSummary | null {
  const run = getMissionRun(runId);
  if (!run) return null;
  return mapRunToSummary(run);
}

export function listMissionRunSummaries(opts?: {
  cwd?: string;
  status?: string;
  limit?: number;
}): MissionRunSummary[] {
  return listMissionRuns(opts).map(mapRunToSummary);
}

export function listMissionStepSummaries(runId: number): MissionStepRunSummary[] {
  return getMissionSteps(runId).map(s => ({
    id: s.id,
    stepId: s.step_id,
    stepOrder: s.step_order,
    role: s.role,
    title: s.title,
    status: s.status,
    startedAt: s.started_at,
    completedAt: s.completed_at,
  }));
}

export function listMissionAssignmentSummaries(runId: number): MissionAssignmentSummary[] {
  return getMissionAssignments(runId).map(a => ({
    id: a.id,
    stepId: a.step_id,
    role: a.role,
    sessionId: a.session_id,
    status: a.status,
    brief: a.brief,
    resultSummary: a.result_summary,
    failureKind: a.failure_kind,
    startedAt: a.started_at,
    completedAt: a.completed_at,
  }));
}

export function listMissionTransferSummaries(runId: number): MissionTransferSummary[] {
  return getMissionTransfers(runId).map(t => ({
    id: t.id,
    stepId: t.step_id,
    fromSessionId: t.from_session_id,
    toSessionId: t.to_session_id,
    kind: t.kind,
    summary: t.summary,
    createdAt: t.created_at,
  }));
}

export function listMissionGateResultSummaries(runId: number): MissionGateResultSummary[] {
  return getMissionGateResults(runId).map(g => ({
    id: g.id,
    stepId: g.step_id,
    gateType: g.gate_type,
    status: g.status,
    evidence: g.evidence,
    checkedAt: g.checked_at,
  }));
}

export function listMissionSessionIds(runId: number): string[] {
  return getMissionRunSessionIds(runId);
}

// ── Helpers ──

function mapRunToSummary(run: MissionRunRow): MissionRunSummary {
  return {
    id: run.id,
    missionName: run.mission_name,
    status: run.status,
    currentStepIndex: run.current_step_index,
    haltKind: run.halt_kind,
    haltMessage: run.halt_message,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
  };
}

// Re-export for modus-mcp routing
export { getMissionRun } from "./mission-db";
