# Companion Moves — Full Reference

Companion moves are structured conversations. The agent reads context, guides a
real discussion, and saves what it learns to files. No submit token, no API contract,
no widget — the conversation itself is the interaction.

## When to Use

Use the companion pattern when:
- The value is the conversation, not a structured artifact
- The move should run for as long as the conversation naturally takes
- Results should be saved to files the agent (or user) can read later
- You don't need schema validation — the agent decides what to save

Do NOT use companion moves when:
- You need structured output with a typed schema → use submit
- You need the agent to interact with state repeatedly → use API contract
- You need per-turn injection → use persistent

## Why Not Submit?

Submit tokens have a 10min TTL. Companion conversations — check-ins, reflections,
coaching sessions — naturally run longer. The buddy's first check-in move used submit
and hit token expiry mid-conversation. The fix: skip submit entirely. The agent writes
files directly when the conversation winds down.

This is simpler, more resilient, and works across any session length.

## move.json — Minimal

```json
{
  "name": "check-in",
  "label": "Check In",
  "description": "Structured catch-up — what's in flight, what changed, what's stuck",
  "icon": "coffee",
  "tags": ["personal", "context"]
}
```

That's it. No `submit`, no `api`, no `widget`, no `persistent`, no `mode`.
The move activates, gather() runs, the agent gets a conversational prompt.

## context.ts — The Pattern

Companion gather() functions follow a consistent structure:

1. **Read previous context** — memory files, last status, user model
2. **Build a conversational prompt** — guide the agent on what to explore
3. **Tell the agent where to save** — explicit file paths for results

```ts
import type { MoveContext } from "../../../harness/move-types";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return fallback; }
}

export async function gather(ctx: MoveContext): Promise<string> {
  // 1. Read previous context
  const memoryDir = join(ctx.cwd, "memory");
  let memoryContext = "";
  try {
    const files = readdirSync(memoryDir).filter(
      (f: string) => f.endsWith(".md") && f !== "project-status.md"
    );
    for (const file of files) {
      const content = readFileOr(join(memoryDir, file), "");
      if (content) memoryContext += `\n--- ${file} ---\n${content}\n`;
    }
  } catch { /* memory dir might not exist yet */ }

  const previousStatus = readFileOr(
    join(ctx.cwd, "memory/project-status.md"), ""
  );
  const today = ctx.date ?? new Date().toISOString().split("T")[0];

  // 2. Build conversational prompt
  let prompt = `# Check-In\n\nToday: ${today}\n\n`;
  prompt += `This is a conversational check-in — not a form, not an interrogation. `;
  prompt += `Guide the conversation naturally through:\n`;
  prompt += `1. **What's in flight** — what are you working on right now?\n`;
  prompt += `2. **What changed** — anything shift since last time?\n`;
  prompt += `3. **What's stuck** — anything blocked or draining energy?\n`;
  prompt += `4. **What's next** — where does attention want to go?\n\n`;
  prompt += `Don't run through these like a checklist. Let the conversation flow. `;
  prompt += `Ask follow-ups. Notice what's unsaid.\n\n`;

  // 3. Tell the agent where to save
  prompt += `**When the conversation winds down:** Save what you learned to `;
  prompt += `\`memory/project-status.md\` and append a dated summary to `;
  prompt += `\`memory/check-in-history.md\`.\n\n`;

  if (memoryContext) prompt += `## What You Know\n\n${memoryContext}\n\n`;
  if (previousStatus.trim()) {
    prompt += `## Last Status\n\n${previousStatus}\n\n`;
    prompt += `Reference naturally — "last time you mentioned X, how's that going?"\n`;
  } else {
    prompt += `## First Check-In\n\nStart broad — get the lay of the land.\n\n`;
  }

  return prompt;
}
```

## Candidate Companion Moves

These are proven or high-value companion patterns:

| Move | Purpose | What gather() reads | What agent saves |
|------|---------|--------------------|--------------------|
| **check-in** | Structured catch-up | memory files, last status | project-status.md, check-in-history.md |
| **reflect** | End-of-session consolidation | conversation context, identity.md, memory/ | Updated identity.md, refined memory files |
| **remember** | Explicit "save this" | user's request, existing memory/ | New or updated memory file |
| **debrief** | Post-incident review | logs, recent git history, memory | incident-log.md, lessons-learned.md |
| **plan** | Goal-setting conversation | current status, past plans | goals.md, next-steps.md |

## Design Principles

1. **The prompt guides, not controls.** List topics to explore, not questions to
   answer in order. The conversation should flow naturally.

2. **Reference previous context.** If the agent knows what was discussed last time,
   it can ask better follow-ups. Always read and inject prior state.

3. **Save instructions go in the prompt.** Be explicit about which files to write
   and what format to use. The agent should know where results go before the
   conversation starts.

4. **No submit, no TTL, no expiry.** The conversation can run as long as it needs.
   The agent writes files when it naturally winds down — not when a token forces it.

5. **Memory as continuity.** Companion moves build value across sessions through
   accumulated memory files. Each check-in reads the previous one. Each reflection
   updates the identity. The files are the memory system.

## Companion vs Persistent

Companion moves are **one-shot activations** — the user starts a check-in, has the
conversation, done. Persistent moves are **ambient** — they inject context on every
turn without the user doing anything.

A companion move could be combined with a persistent move: the check-in runs as a
companion, but a persistent move injects the latest project-status.md into every
regular session so the agent always has context.
