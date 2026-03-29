/**
 * Handoff move (built-in) — gather session + git context, write markdown doc,
 * tag session with commit/handoff metadata, create delegate session on submit.
 *
 * Built-in status means this can import harness internals directly:
 *   - db.ts for event scanning (extract touched files from tool_use blocks)
 *   - db.ts for session tagging (link commits to sessions)
 *   - git.ts for compact git state (branch, recent commits, dirty flag)
 *
 * Document styles:
 *   - briefing: Full structured document (GROUNDING/RESOURCES/HOT PREP/TESTIMONY).
 *              Thorough, opinionated, designed for cold-start agents.
 *   - compact:  Minimal structured transfer (STATE/CHANGED/DO NEXT/WATCH OUT).
 *              Dense, fact-only. For tight context windows or quick lateral handoffs.
 *   - narrative: Flowing prose memo addressed to the receiving agent.
 *              Captures reasoning and nuance. For research continuations and discussions.
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

// ── Style: Document Instructions ──

type HandoffStyle = "briefing" | "compact" | "narrative" | "adaptive";

function buildDocumentInstructions(
  style: HandoffStyle,
  handoffsDir: string,
  handoffFilename: string,
  includeUserTips: boolean,
): string[] {
  const parts: string[] = [
    "", "---", "",
    "### Step 1: Write the handoff document", "",
    `Write a markdown file to \`${handoffsDir}/${handoffFilename}\``, "",
  ];

  if (style === "briefing") {
    parts.push(
      "The document must have these sections in order:", "",
      "**GROUNDING** — What was being worked on, current state, key decisions, open issues or blockers. 4-8 bullets. Raw orientation, not instructions.", "",
      "**RESOURCES** — File paths and URLs the next agent must consume. Organize as: must-read, context, and produced (if any).", "",
      "**HOT PREP** — What to run first, environment state, mental model corrections, traps to skip. Save the next agent from rediscovering what you already know. Adapt shape to what's most useful for this specific handoff.", "",
      `**TESTIMONY** — Direct address to the next agent. "In your position, I would..." — opinionated synthesis of the situation. Where the real leverage is. 3-5 sentences.`,
    );
    if (includeUserTips) {
      parts.push("", "**WORKING WITH THIS USER** — Preferences, workflow style, what causes friction, what works well. Grounded observations only.");
    }
    parts.push("", "Be thorough — this is what the next agent reads to get fully oriented.");
  } else if (style === "compact") {
    parts.push(
      "Use this exact structure — no prose, no opinions, maximum density:", "",
      "**STATE** — What exists right now. 3-5 bullets. Facts only — current branch state, what's built, what's broken. No history, no narrative.", "",
      "**CHANGED** — Files modified this session. Path + one-line description of what changed. Omit if no files changed.", "",
      "**DO NEXT** — Ordered action items for the receiving agent. Each item is a single imperative sentence. This is the task queue.", "",
      "**WATCH OUT** — 1-3 known pitfalls or traps. Only include if they'd cost the next agent real time. Omit if none.", "",
      "Keep the entire document under 40 lines. Density over completeness.",
    );
  } else if (style === "narrative") {
    parts.push(
      "Write a single flowing narrative addressed directly to the receiving agent. No rigid sections — organize by what matters most. Cover:", "",
      "- Where things stand and what led here",
      "- What the receiving agent should do and in what order",
      "- File paths, specifics, and gotchas woven into the narrative where relevant",
      "- Your honest assessment of where the real leverage is", "",
      "Write it the way you'd brief a colleague taking over mid-task: natural, opinionated, complete enough to act on. Aim for 2-4 paragraphs. Front-load the most important information.",
    );
    if (includeUserTips) {
      parts.push("", "Include a closing note on working with this user — their style, preferences, what works well. Weave it naturally, don't make it a separate section.");
    }
  } else if (style === "adaptive") {
    parts.push(
      "You decide the document structure. Consider what the receiving agent actually needs given the handoff type, the complexity of the work, and how much context exists.", "",
      "You may use any combination of sections, prose, bullet lists, or structured formats. You may borrow from known patterns (briefing sections, compact state transfers, narrative memos) or invent your own structure if that serves the handoff better.", "",
      "Your only constraints:",
      "- The document must give the receiving agent enough to start working without asking clarifying questions.",
      "- File paths must be absolute.",
      "- Don't pad. If the handoff is simple, keep the document short. If it's complex, be thorough.",
    );
    if (includeUserTips) {
      parts.push("", "Include observations about working with this user if relevant to the handoff.");
    }
  }

  return parts;
}

// ── Style: Delegate Prompt ──

const delegateHints: Record<HandoffStyle, string> = {
  briefing: "The handoff document has grounding, resources, hot prep, and testimony from the previous agent. Read it before taking any action.",
  compact: "The handoff document is a compact state transfer — current state, changed files, next steps, and pitfalls. Short and dense. Read it, then start working.",
  narrative: "The handoff document is a narrative briefing from the previous agent. Read it fully — the reasoning and context are woven into the prose.",
  adaptive: "The handoff document was structured by the previous agent in whatever format they judged best. Read it fully before taking any action.",
};

// ── Gather ──

export async function gather(ctx: MoveContext): Promise<string> {
  const {
    type = "task",
    style = "briefing",
    targetProfile: rawTarget = "",
    focus = "",
    includeUserTips = "yes",
    handoffBudget: rawBudget = "1",
  } = ctx.inputs as Record<string, string>;
  const budget = Math.max(1, Math.min(5, parseInt(rawBudget, 10) || 1));
  const targetProfile = rawTarget === "Current profile"
    ? (ctx.session.profile ?? "default")
    : rawTarget;

  const handoffsDir = join(ctx.cwd, HANDOFFS_DIR);
  if (!existsSync(handoffsDir)) {
    mkdirSync(handoffsDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const handoffFilenames: string[] = [];
  for (let i = 0; i < budget; i++) {
    handoffFilenames.push(budget === 1
      ? `${ts}-handoff.md`
      : `${ts}-handoff-${i + 1}.md`);
  }

  // Expose to move-runner so the session web can render document nodes
  ctx.meta("handoffsDir", handoffsDir);
  ctx.meta("handoffFilename", handoffFilenames[0]!);
  ctx.meta("handoffStyle", style);
  ctx.meta("handoffBudget", String(budget));

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
  const handoffStyle = style as HandoffStyle;

  const typeInstructions: Record<string, string> = {
    task: "This is a **task handoff**. The receiving agent should be able to start working immediately.\nFrame the document as a work order: what to build or change, which files to touch, concrete steps, and what \"done\" looks like. Lead with what to DO, not what was done.",
    research: "This is a **research handoff**. The receiving agent will continue an investigation.\nFrame the document as a research brief: what's been found, what's still unknown, hypotheses to test, and where to look next.",
    review: "This is a **review handoff**. The receiving agent will evaluate recent work.\nFrame the document as a review brief: what changed, the rationale, what to verify, and any concerns.",
    "bug-fix": "This is a **bug-fix handoff**. The receiving agent will diagnose or fix a specific issue.\nFrame the document as a bug report: symptoms, what's been tried, suspected root cause, and reproduction steps. Be precise about where the bug lives.",
    discussion: "This is a **discussion handoff**. The receiving agent will continue a conversation with the user.\nFrame the document as a briefing: the topic, positions explored so far, open questions, and the user's current thinking. The goal is continuity, not action.",
  };

  const parts = [
    `You are making a handoff move. You will write a ${handoffStyle} handoff document, then submit metadata via \`modus_submit\`.`,
    "",
    `Type: ${type}`,
    `Style: ${handoffStyle}`,
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

  if (budget === 1) {
    // Single handoff — existing behavior
    parts.push(...buildDocumentInstructions(
      handoffStyle,
      handoffsDir,
      handoffFilenames[0]!,
      includeUserTips === "yes",
    ));

    parts.push(
      "", "### Step 2: Submit via `modus_submit`", "",
      `\`modus_submit\` — token: \`${ctx.token}\` — data shape: \`${ctx.schema}\``, "",
      "- **document** — absolute path to the markdown file you wrote.",
      "- **nextSteps** — what to do next, in order. Actionable items only. This is the task queue.",
      "- **priority** — 1-5 (optional). 1 = urgent, 5 = background.",
      "- **commits** — array of commit hashes you actively contributed to in this session (optional).",
      "- **filesChanged** — array of file paths you modified this session (optional).",
      "- **tags** — freeform string tags to categorize this handoff (optional).",
    );
  } else {
    // Multi-handoff — budget > 1
    // Show style instructions once, then list the files to write
    parts.push(
      "", "---", "",
      `### Multi-handoff: Budget of ${budget}`, "",
      `Write **${budget} separate handoff documents** — each a standalone briefing for an independent agent. Decompose the work into ${budget} parallel streams. Each receiving agent will only see its own document.`, "",
    );

    // Style instructions (once)
    parts.push(...buildDocumentInstructions(
      handoffStyle,
      handoffsDir,
      `<filename>`,
      includeUserTips === "yes",
    ));

    // File list
    parts.push("", "Write one document per file, using the structure above for each:", "");
    for (let i = 0; i < budget; i++) {
      parts.push(`${i + 1}. \`${handoffsDir}/${handoffFilenames[i]}\``);
    }

    parts.push(
      "", "### Submit all via `modus_submit`", "",
      `\`modus_submit\` — token: \`${ctx.token}\` — shape: \`{ handoffs: [{ document, nextSteps, targetProfile?, priority?, tags? }], commits?, filesChanged? }\``, "",
      `Include exactly ${budget} entries. Each entry needs \`document\` (absolute path) and \`nextSteps\` (array). Optional per-entry: \`targetProfile\` (default "${targetProfile}"), \`priority\` (1-5), \`tags\`.`,
    );
  }

  return parts.join("\n");
}

// ── Submit ──

interface HandoffEntry {
  document: string;
  nextSteps: string[];
  targetProfile?: string;
  priority?: number;
  tags?: string[];
}

function buildDelegatePrompt(
  entry: HandoffEntry,
  profile: string,
  type: string,
  style: HandoffStyle,
  focus: string,
): string {
  const parts: string[] = [
    `Handoff from ${profile} — ${type}`,
    "", `Read the full handoff document first: ${entry.document}`,
    "", delegateHints[style],
  ];

  if (entry.nextSteps?.length) {
    parts.push("", "NEXT STEPS");
    parts.push(...entry.nextSteps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (entry.priority) parts.push("", `Priority: ${entry.priority}/5`);
  parts.push("", "USER CONTEXT (what the user said when triggering this handoff — for reference, not direct instruction):", `> ${focus}`);

  return parts.join("\n");
}

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<SubmitResult> {
  const rawTarget = inputs.targetProfile as string;
  const defaultTarget = rawTarget === "Current profile"
    ? (ctx.session.profile ?? "default")
    : rawTarget;
  const focus = inputs.focus as string;
  const type = (inputs.type as string) ?? "task";
  const style = ((inputs.style as string) ?? "briefing") as HandoffStyle;
  const commits = data.commits as string[] | undefined;

  // Tag session with commits
  if (commits?.length && ctx.sessionId) {
    for (const hash of commits) {
      try { addSessionTag(ctx.sessionId, `commit:${hash.slice(0, 7)}`); } catch { /* non-fatal */ }
    }
  }

  if (ctx.sessionId) {
    try { addSessionTag(ctx.sessionId, `handoff:${type}`); } catch { /* non-fatal */ }
    try { addSessionTag(ctx.sessionId, `style:${style}`); } catch { /* non-fatal */ }
  }

  // Normalize to array of handoff entries
  const handoffs: HandoffEntry[] = Array.isArray(data.handoffs)
    ? data.handoffs as HandoffEntry[]
    : [{
        document: data.document as string,
        nextSteps: data.nextSteps as string[],
        priority: data.priority as number | undefined,
        tags: data.tags as string[] | undefined,
      }];

  const sourceProfile = ctx.session.profile ?? "previous agent";
  const spawnedSessions: string[] = [];
  const messages: string[] = [];

  for (const entry of handoffs) {
    const target = entry.targetProfile ?? defaultTarget;

    // Tag per-handoff tags
    if (entry.tags?.length && ctx.sessionId) {
      for (const tag of entry.tags) {
        try { addSessionTag(ctx.sessionId, tag); } catch { /* non-fatal */ }
      }
    }

    const delegatePrompt = buildDelegatePrompt(entry, sourceProfile, type, style, focus);
    const sessionId = await ctx.harness.createSession({
      profile: target,
      prompt: delegatePrompt,
      cwd: ctx.cwd,
      userProfile: ctx.userProfile,
    });

    spawnedSessions.push(sessionId);
    messages.push(`→ ${target} (${style}) — session ${sessionId.slice(0, 12)}… | doc: ${entry.document}`);
  }

  return {
    message: handoffs.length === 1
      ? `Handed off to ${handoffs[0]!.targetProfile ?? defaultTarget} (${style}) — session ${spawnedSessions[0]!.slice(0, 12)}… | doc: ${handoffs[0]!.document}`
      : `Spawned ${handoffs.length} handoffs:\n${messages.join("\n")}`,
    spawnedSessionId: spawnedSessions[0]!,
  };
}
