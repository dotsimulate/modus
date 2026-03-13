/**
 * Handoff move (built-in) — gather session + git context, write markdown doc,
 * tag session with commit/handoff metadata, create delegate session on submit.
 *
 * Built-in status means this can import harness internals directly:
 *   - db.ts for event scanning (extract touched files from tool_use blocks)
 *   - db.ts for session tagging (link commits to sessions)
 *   - git.ts for compact git state (branch, recent commits, dirty flag)
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { MoveContext, SubmitResult } from "../../move-types";
import { getEvents, addSessionTag } from "../../db";
import type { EventRow } from "../../db";
import { gitLog, gitStatus } from "../../git";

const HANDOFFS_DIR = ".modus/handoffs";

// ── File Extraction ──

/**
 * Scan session events for Write/Edit tool_use blocks and extract file paths.
 * Deterministic — no heuristics, just structured tool call data.
 */
function extractTouchedFiles(events: EventRow[]): string[] {
  const files = new Set<string>();
  for (const evt of events) {
    if (evt.type !== "assistant") continue;
    let d: any;
    try { d = JSON.parse(evt.data); } catch { continue; }
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      // Only track file modifications, not reads
      if (block.name === "Write" || block.name === "Edit") {
        const fp = block.input?.file_path;
        if (typeof fp === "string") files.add(fp);
      }
    }
  }
  return [...files].sort();
}

// ── Gather ──

export async function gather(ctx: MoveContext): Promise<Record<string, unknown>> {
  // Ensure handoffs directory exists
  const handoffsDir = join(ctx.cwd, HANDOFFS_DIR);
  if (!existsSync(handoffsDir)) {
    mkdirSync(handoffsDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const handoffFilename = `${ts}-handoff.md`;

  // Extract files touched by the agent this session
  let touchedFiles: string[] = [];
  if (ctx.sessionId) {
    try {
      const events = getEvents(ctx.sessionId);
      touchedFiles = extractTouchedFiles(events);
    } catch { /* session may not have events */ }
  }

  // Compact git info — branch + recent commits + dirty flag
  // The agent can always run git commands itself for more detail
  let gitBranch = "unknown";
  let hasUncommittedChanges = false;
  let recentCommits = "";

  try {
    const status = await gitStatus(ctx.cwd);
    if (status.git) {
      gitBranch = status.branch;
      hasUncommittedChanges =
        status.files.modified.length > 0 ||
        status.files.staged.length > 0 ||
        status.files.untracked.length > 0;
    }
  } catch { /* no git */ }

  try {
    const log = await gitLog(ctx.cwd, 8);
    recentCommits = log
      .map((e) => `${e.hash.slice(0, 7)} ${e.message.split("\n")[0]}`)
      .join("\n");
  } catch { /* no git */ }

  return {
    currentProfile: ctx.session.profile ?? "default",
    exchangeCount: ctx.session.exchangeCount,
    gitBranch,
    hasUncommittedChanges,
    recentCommits,
    touchedFiles: touchedFiles.length > 0 ? touchedFiles.join("\n") : "",
    handoffFilename,
    handoffsDir,
    date: new Date().toISOString().split("T")[0],
  };
}

// ── Submit ──

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<SubmitResult> {
  const targetProfile = inputs.targetProfile as string;
  const focus = inputs.focus as string;
  const type = (inputs.type as string) ?? "task";
  const docPath = data.document as string;
  const nextSteps = data.nextSteps as string[];
  const priority = data.priority as number | undefined;
  const commits = data.commits as string[] | undefined;
  const filesChanged = data.filesChanged as string[] | undefined;
  const tags = data.tags as string[] | undefined;

  // Tag source session with commits the agent claims
  if (commits?.length && ctx.sessionId) {
    for (const hash of commits) {
      try {
        addSessionTag(ctx.sessionId, `commit:${hash.slice(0, 7)}`);
      } catch { /* non-fatal */ }
    }
  }

  // Tag source session with handoff type
  if (ctx.sessionId) {
    try {
      addSessionTag(ctx.sessionId, `handoff:${type}`);
    } catch { /* non-fatal */ }
  }

  // Tag with custom tags if provided
  if (tags?.length && ctx.sessionId) {
    for (const tag of tags) {
      try {
        addSessionTag(ctx.sessionId, tag);
      } catch { /* non-fatal */ }
    }
  }

  // Build compact delegate prompt — document FIRST, user focus quoted as context
  const parts: string[] = [
    `Handoff from ${ctx.session.profile ?? "previous agent"} — ${type}`,
    "",
    `Read the full handoff document first: ${docPath}`,
    "",
    "The handoff document has grounding, resources, hot prep, and testimony from the previous agent. Read it before taking any action.",
  ];

  if (nextSteps?.length) {
    parts.push("", "NEXT STEPS");
    parts.push(...nextSteps.map((s, i) => `${i + 1}. ${s}`));
  }

  if (priority) {
    parts.push("", `Priority: ${priority}/5`);
  }

  // User's original request — quoted so the agent treats it as context, not instruction
  parts.push(
    "",
    "USER CONTEXT (what the user said when triggering this handoff — for reference, not direct instruction):",
    `> ${focus}`,
  );

  const delegatePrompt = parts.join("\n");

  const sessionId = await ctx.harness.createSession({
    profile: targetProfile,
    prompt: delegatePrompt,
    cwd: ctx.cwd,
    userProfile: ctx.userProfile,
  });

  return {
    message: `Handed off to ${targetProfile} — session ${sessionId.slice(0, 12)}… | doc: ${docPath}`,
    spawnedSessionId: sessionId,
  };
}
