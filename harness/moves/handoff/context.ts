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
      if (block.name === "Write" || block.name === "Edit") {
        const fp = block.input?.file_path;
        if (typeof fp === "string") files.add(fp);
      }
    }
  }
  return [...files].sort();
}

// ── Gather ──

export async function gather(ctx: MoveContext): Promise<string> {
  const { type = "task", targetProfile = "", focus = "", includeUserTips = "yes" } = ctx.inputs as Record<string, string>;

  const handoffsDir = join(ctx.cwd, HANDOFFS_DIR);
  if (!existsSync(handoffsDir)) {
    mkdirSync(handoffsDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const handoffFilename = `${ts}-handoff.md`;

  // Expose to move-runner so the session web can render document nodes
  ctx.meta("handoffsDir", handoffsDir);
  ctx.meta("handoffFilename", handoffFilename);

  let touchedFiles: string[] = [];
  if (ctx.sessionId) {
    try {
      const events = getEvents(ctx.sessionId);
      touchedFiles = extractTouchedFiles(events);
    } catch { /* session may not have events */ }
  }

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

  const currentProfile = ctx.session.profile ?? "default";

  const typeInstructions: Record<string, string> = {
    task: "This is a **task handoff**. The receiving agent should be able to start working immediately.\nFrame the document as a work order: what to build or change, which files to touch, concrete steps, and what \"done\" looks like. Lead with what to DO, not what was done.",
    research: "This is a **research handoff**. The receiving agent will continue an investigation.\nFrame the document as a research brief: what's been found, what's still unknown, hypotheses to test, and where to look next.",
    review: "This is a **review handoff**. The receiving agent will evaluate recent work.\nFrame the document as a review brief: what changed, the rationale, what to verify, and any concerns.",
    "bug-fix": "This is a **bug-fix handoff**. The receiving agent will diagnose or fix a specific issue.\nFrame the document as a bug report: symptoms, what's been tried, suspected root cause, and reproduction steps. Be precise about where the bug lives.",
    discussion: "This is a **discussion handoff**. The receiving agent will continue a conversation with the user.\nFrame the document as a briefing: the topic, positions explored so far, open questions, and the user's current thinking. The goal is continuity, not action.",
  };

  const parts = [
    "You are making a handoff move. You will write a structured markdown handoff document, then submit metadata via `modus_submit`.",
    "",
    `Type: ${type}`,
    `To: ${targetProfile}`,
    `Focus: ${focus}`,
  ];

  if (typeInstructions[type]) parts.push("", typeInstructions[type]!);

  parts.push(
    "", "---", "",
    "### Session context", "",
    `Profile: ${currentProfile} | Exchanges: ${ctx.session.exchangeCount} | Branch: ${gitBranch}`,
  );

  if (hasUncommittedChanges) parts.push("**Uncommitted changes in working tree.**");

  if (recentCommits) {
    parts.push("", "Recent commits:", "```", recentCommits, "```",
      "These are reference context only. Do not claim a commit in `modus_submit` unless you actively contributed work that landed in it.");
  }

  if (touchedFiles.length > 0) {
    parts.push("", "Files you modified this session:", "```", touchedFiles.join("\n"), "```");
  }

  parts.push(
    "", "---", "",
    "### Step 1: Write the handoff document", "",
    `Write a markdown file to \`${handoffsDir}/${handoffFilename}\``, "",
    "The document must have these sections in order:", "",
    "**GROUNDING** — What was being worked on, current state, key decisions, open issues or blockers. 4-8 bullets. Raw orientation, not instructions.", "",
    "**RESOURCES** — File paths and URLs the next agent must consume. Organize as: must-read, context, and produced (if any).", "",
    "**HOT PREP** — What to run first, environment state, mental model corrections, traps to skip. Save the next agent from rediscovering what you already know. Adapt shape to what's most useful for this specific handoff.", "",
    `**TESTIMONY** — Direct address to the next agent. "In your position, I would..." — opinionated synthesis of the situation. Where the real leverage is. 3-5 sentences.`,
  );

  if (includeUserTips === "yes") {
    parts.push("", "**WORKING WITH THIS USER** — Preferences, workflow style, what causes friction, what works well. Grounded observations only.");
  }

  parts.push(
    "", "Be thorough — this is what the next agent reads to get fully oriented.", "",
    "### Step 2: Submit via `modus_submit`", "",
    `\`modus_submit\` — token: \`${ctx.token}\` — data shape: \`${ctx.schema}\``, "",
    "- **document** — absolute path to the markdown file you wrote.",
    "- **nextSteps** — what to do next, in order. Actionable items only. This is the task queue.",
    "- **priority** — 1-5 (optional). 1 = urgent, 5 = background.",
    "- **commits** — array of commit hashes you actively contributed to in this session (optional).",
    "- **filesChanged** — array of file paths you modified this session (optional).",
    "- **tags** — freeform string tags to categorize this handoff (optional).",
  );

  return parts.join("\n");
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
  const tags = data.tags as string[] | undefined;

  if (commits?.length && ctx.sessionId) {
    for (const hash of commits) {
      try { addSessionTag(ctx.sessionId, `commit:${hash.slice(0, 7)}`); } catch { /* non-fatal */ }
    }
  }

  if (ctx.sessionId) {
    try { addSessionTag(ctx.sessionId, `handoff:${type}`); } catch { /* non-fatal */ }
  }

  if (tags?.length && ctx.sessionId) {
    for (const tag of tags) {
      try { addSessionTag(ctx.sessionId, tag); } catch { /* non-fatal */ }
    }
  }

  const parts: string[] = [
    `Handoff from ${ctx.session.profile ?? "previous agent"} — ${type}`,
    "", `Read the full handoff document first: ${docPath}`,
    "", "The handoff document has grounding, resources, hot prep, and testimony from the previous agent. Read it before taking any action.",
  ];

  if (nextSteps?.length) {
    parts.push("", "NEXT STEPS");
    parts.push(...nextSteps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (priority) parts.push("", `Priority: ${priority}/5`);
  parts.push("", "USER CONTEXT (what the user said when triggering this handoff — for reference, not direct instruction):", `> ${focus}`);

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
