import type { PromptGatherContext } from "../../gather-types";

export async function gather(ctx: PromptGatherContext): Promise<string> {
  const { type = "task", focus = "", includeUserTips = "yes", text } = ctx.inputs as Record<string, string>;

  // Gather git context
  const [log, status, diff] = await Promise.all([
    ctx.git("log", "--oneline", "-8"),
    ctx.git("status", "--short"),
    ctx.git("diff", "HEAD~1", "--stat"),
  ]);

  const typeInstructions: Record<string, string> = {
    research: "This is a research handoff — prioritize docs, sources, and URLs. Flag anything that still needs verification.",
  };

  const parts = [
    "Write a structured handoff document for the next agent picking up this work. Output the handoff only — no preamble, no commentary around it.",
    "",
    `Handoff type: ${type}`,
  ];

  if (focus) parts.push(`Focus: ${focus}`);
  if (text) parts.push(`Notes: ${text}`);

  parts.push(
    "",
    "Session context:",
    log,
    "",
    "Status:",
    status || "(clean)",
    "",
    "Recent diff:",
    diff,
    "",
    "---",
    "",
    "Produce exactly these 5 (or 6) sections in this exact order. Do not combine or reorder them.",
    "",
    "GROUNDING",
    "",
    "What was being worked on, the current line of thinking, key decisions made, and any open issues or blockers. Raw orientation context only — not instructions, not next steps. 4-8 bullets.",
    "",
    "RESOURCES",
    "",
    "Every file path and URL the next agent must consume to get fully up to speed. Organize by:",
    "- Must-read — files or URLs directly in scope",
    "- Context — background files useful for deeper understanding",
    "- Produced — any outputs, artifacts, or generated files from this session (omit if none)",
  );

  if (typeInstructions[type]) parts.push(typeInstructions[type]!);

  parts.push(
    "",
    "NEXT STEPS",
    "",
    "Specific, actionable tasks only. Numbered. Ordered by priority or sequence. No summaries of completed work — only what needs to happen next. This section is completely separate from grounding and resources.",
    "",
    "HOT PREP",
    "",
    `Direct recommendations to the next agent on how to orient and prepare before starting work. Calibrated for a ${type} handoff. Transfer the in-the-flow knowledge that saves the most time — what to run first, environment state, mental model corrections, traps to skip, anything the next agent would otherwise have to rediscover on their own. This section can take different shapes depending on what's most useful for this specific handoff.`,
    "",
    "TESTIMONY",
    "",
    "Direct address to the next agent. \"In your position, I would...\" — a clear, opinionated synthesis of the whole situation. What matters most. Where the real leverage is. This is a larger vector, not a task list. 3-5 sentences, high signal only.",
  );

  if (includeUserTips === "yes") {
    parts.push(
      "",
      "WORKING WITH THIS USER",
      "",
      "Tips for collaborating effectively with this specific user. Their preferences, workflow style, what causes friction, what works well. Include anything that would help the next agent avoid mistakes or work more naturally. (Keep this grounded — don't invent preferences that weren't demonstrated.)",
    );
  }

  parts.push(
    "",
    "---",
    `Generated ${ctx.date}`,
  );

  return parts.join("\n");
}
